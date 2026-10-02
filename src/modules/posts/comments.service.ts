import {
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { NotificationsService } from '../notifications/notifications.service';
import { MentionNotificationsService } from '../notifications/mention-notifications.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PERMISSIONS } from '../../authz/permissions';
import { hasPermission, isResourceOwner, type Actor } from '../../authz/policy';
import { Post } from '../../database/schemas/post.schema';
import { PostComment } from '../../database/schemas/post-comment.schema';
import { UsersService } from '../users/users.service';
import { LoggerService } from '../../infra/logger.service';
import { textPreview } from '../../infra/log-helpers';

function postIdMatch(id: Types.ObjectId | string) {
    const objectId =
        id instanceof Types.ObjectId ? id : new Types.ObjectId(String(id));
    return { $in: [objectId, String(objectId)] };
}

export type CommentLean = {
    _id: Types.ObjectId;
    author: unknown;
    post_id: Types.ObjectId;
    parent_comment_id?: Types.ObjectId | null;
    likes?: unknown[];
    comment_text?: string;
    replies?: CommentLean[];
};

@Injectable()
export class CommentsService {
    constructor(
        @InjectModel(PostComment.name)
        private readonly comments: Model<PostComment>,
        @InjectModel(Post.name) private readonly posts: Model<Post>,
        private readonly users: UsersService,
        private readonly notifications: NotificationsService,
        private readonly mentionNotifications: MentionNotificationsService,
        private readonly logger: LoggerService,
    ) {}

    buildTree(comments: CommentLean[]) {
        const commentMap = new Map<string, CommentLean>();
        const roots: CommentLean[] = [];

        for (const comment of comments) {
            comment.replies = [];
            commentMap.set(String(comment._id), comment);
        }

        for (const comment of comments) {
            if (!comment.parent_comment_id) {
                roots.push(comment);
                continue;
            }
            const parent = commentMap.get(String(comment.parent_comment_id));
            if (parent) {
                parent.replies!.push(comment);
            } else {
                roots.push(comment);
            }
        }

        return roots;
    }

    treesByPost(comments: CommentLean[]) {
        const byPost = new Map<string, CommentLean[]>();
        for (const comment of comments) {
            const postId = String(comment.post_id);
            const list = byPost.get(postId) || [];
            list.push(comment);
            byPost.set(postId, list);
        }
        const result = new Map<string, CommentLean[]>();
        for (const [postId, postComments] of byPost) {
            result.set(postId, this.buildTree(postComments));
        }
        return result;
    }

    async attachAuthors(comments: CommentLean[]) {
        const authors = await this.users.getPublicByIds(
            comments.map((comment) => comment.author),
        );
        const authorMap = new Map(
            authors.map((author) => [String(author._id), author]),
        );
        for (const comment of comments) {
            comment.author = authorMap.get(String(comment.author)) || null;
        }
        return comments;
    }

    async countsByPost(postIds: Types.ObjectId[]) {
        if (!postIds.length) {
            return new Map<string, number>();
        }
        const rows = await this.comments.aggregate<{
            _id: Types.ObjectId;
            count: number;
        }>([
            {
                $match: {
                    post_id: {
                        $in: postIds.flatMap((id) => [id, String(id)]),
                    },
                },
            },
            { $group: { _id: '$post_id', count: { $sum: 1 } } },
        ]);
        const counts = new Map<string, number>();
        for (const row of rows) {
            const key = String(row._id);
            counts.set(key, (counts.get(key) || 0) + row.count);
        }
        return counts;
    }

    async forPosts(postIds: Types.ObjectId[]) {
        if (!postIds.length) {
            return new Map<string, CommentLean[]>();
        }
        const comments = await this.comments
            .find({
                post_id: {
                    $in: postIds.flatMap((id) => [id, String(id)]),
                },
            })
            .lean<CommentLean[]>();
        return this.treesByPost(comments);
    }

    async listForPost(postId: string, expand?: string): Promise<CommentLean[]> {
        const post = await this.posts.findById(postId).lean();
        if (!post) {
            throw new NotFoundException('Post not found!');
        }
        const comments = await this.comments
            .find({ post_id: postIdMatch(post._id) })
            .lean<CommentLean[]>();
        if (
            expand === 'author' ||
            String(expand || '')
                .split(',')
                .includes('author')
        ) {
            await this.attachAuthors(comments);
        }
        return this.buildTree(comments);
    }

    async create(
        postId: string,
        commentText: string,
        parentCommentId: string | undefined,
        actor: Actor,
    ) {
        const post = await this.posts.findById(postId).lean();
        if (!post) {
            throw new NotFoundException('Post not found!');
        }

        if (parentCommentId) {
            const parent = await this.comments
                .findById(parentCommentId)
                .lean<CommentLean>();
            if (!parent) {
                throw new NotFoundException('Parent comment not found!');
            }
            if (String(parent.post_id) !== String(postId)) {
                throw new ConflictException(
                    'Parent comment does not belong to this post!',
                );
            }
            const result = await this.comments.create({
                post_id: post._id,
                comment_text: commentText,
                author: actor.id,
                parent_comment_id: parentCommentId,
            });
            const mentionedUserIds =
                await this.mentionNotifications.resolveMentionedUserIds(
                    commentText,
                );
            if (
                String(parent.author) !== actor.id &&
                !mentionedUserIds.has(String(parent.author))
            ) {
                await this.notifications.sendNotification(
                    String(parent.author),
                    {
                        type: 'reply_comment',
                        user: actor.id,
                        comment: String(result._id),
                        post: postId,
                    },
                );
            }
            await this.mentionNotifications.notifyFromText({
                actorId: actor.id,
                text: commentText,
                postId,
                commentId: String(result._id),
                excludeUserIds: [actor.id],
            });
            await this.logger.action(
                'reply_comment',
                actor,
                {
                    post: postId,
                    post_title: post.title,
                    comment: String(result._id),
                    comment_text: textPreview(commentText),
                    parent_comment: parentCommentId,
                    target_user: String(parent.author),
                },
                `User ${actor.nick_name} replied to comment ${parentCommentId}`,
            );
            return result.toObject();
        }

        const result = await this.comments.create({
            post_id: post._id,
            comment_text: commentText,
            author: actor.id,
        });
        const mentionedUserIds =
            await this.mentionNotifications.resolveMentionedUserIds(
                commentText,
            );
        if (
            String(post.author) !== actor.id &&
            !mentionedUserIds.has(String(post.author))
        ) {
            await this.notifications.sendNotification(String(post.author), {
                type: 'comment_post',
                user: actor.id,
                post: postId,
                comment: String(result._id),
            });
        }
        await this.mentionNotifications.notifyFromText({
            actorId: actor.id,
            text: commentText,
            postId,
            commentId: String(result._id),
            excludeUserIds: [actor.id],
        });
        await this.logger.action(
            'comment_post',
            actor,
            {
                post: postId,
                post_title: post.title,
                comment: String(result._id),
                comment_text: textPreview(commentText),
            },
            `User ${actor.nick_name} commented on post ${postId}`,
        );
        return result.toObject();
    }

    async remove(commentId: string, actor: Actor) {
        const root = await this.comments
            .findById(commentId)
            .lean<CommentLean>();
        if (!root) {
            throw new NotFoundException('Comment not found!');
        }
        if (
            !isResourceOwner(root.author, actor.id) &&
            !hasPermission(actor, PERMISSIONS.DELETE_ANY_COMMENT)
        ) {
            throw new ForbiddenException(
                "You don't have permission to delete this comment",
            );
        }

        const comments = await this.comments
            .find({ post_id: postIdMatch(root.post_id) })
            .lean<CommentLean[]>();
        const ids = this.idsToDelete(comments, root._id);
        const result = await this.comments.deleteMany({ _id: { $in: ids } });
        await this.users.removeNotifications({ comment: { $in: ids } });
        await this.logger.action(
            'delete_comment',
            actor,
            {
                post: String(root.post_id),
                post_title: await this.postTitle(root.post_id),
                comment: commentId,
                comment_text: textPreview(root.comment_text),
                comment_author: String(root.author),
                removed: ids.length,
            },
            `User ${actor.nick_name} deleted comment ${commentId}`,
        );
        return result;
    }

    private idsToDelete(comments: CommentLean[], rootId: Types.ObjectId) {
        const childrenMap = new Map<string, Types.ObjectId[]>();
        for (const comment of comments) {
            if (!comment.parent_comment_id) continue;
            const parentId = String(comment.parent_comment_id);
            const children = childrenMap.get(parentId) || [];
            children.push(comment._id);
            childrenMap.set(parentId, children);
        }
        const result = [rootId];
        const queue = [String(rootId)];
        while (queue.length) {
            const parentId = queue.shift()!;
            for (const childId of childrenMap.get(parentId) || []) {
                result.push(childId);
                queue.push(String(childId));
            }
        }
        return result;
    }

    async edit(
        commentId: string,
        commentText: string | undefined,
        actor: Actor,
    ) {
        const comment = await this.comments
            .findById(commentId)
            .lean<CommentLean>();
        if (!comment) {
            throw new NotFoundException('Comment not found!');
        }
        if (!isResourceOwner(comment.author, actor.id)) {
            throw new ForbiddenException(
                "You don't have permission to edit this comment",
            );
        }
        const updated = await this.comments
            .findByIdAndUpdate(
                commentId,
                { comment_text: commentText },
                { returnDocument: 'after', runValidators: true },
            )
            .lean();
        if (commentText !== undefined) {
            await this.mentionNotifications.notifyNewMentions(
                String(comment.comment_text || ''),
                commentText,
                {
                    actorId: actor.id,
                    postId: String(comment.post_id),
                    commentId,
                    excludeUserIds: [actor.id],
                },
            );
        }
        if (
            commentText !== undefined &&
            String(comment.comment_text ?? '') !== commentText
        ) {
            await this.logger.action(
                'update_comment',
                actor,
                {
                    post: String(comment.post_id),
                    post_title: await this.postTitle(comment.post_id),
                    comment: commentId,
                    changes: [
                        {
                            field: 'text',
                            from: textPreview(comment.comment_text),
                            to: textPreview(commentText),
                        },
                    ],
                },
                `User ${actor.nick_name} edited comment ${commentId}`,
            );
        }
        return updated;
    }

    async like(commentId: string, actor: Actor) {
        const comment = await this.comments
            .findById(commentId)
            .lean<CommentLean>();
        if (!comment) {
            throw new NotFoundException('Comment not found!');
        }
        if ((comment.likes || []).some((id) => String(id) === actor.id)) {
            throw new ConflictException('You have already liked this comment!');
        }
        const liked = await this.comments
            .findByIdAndUpdate(
                commentId,
                { $addToSet: { likes: actor.id } },
                { returnDocument: 'after', runValidators: true },
            )
            .lean();
        await this.logger.action('like_comment', actor, {
            post: String(comment.post_id),
            post_title: await this.postTitle(comment.post_id),
            comment: commentId,
            comment_text: textPreview(comment.comment_text),
            comment_author: String(comment.author),
        });
        return liked;
    }

    async unlike(commentId: string, actor: Actor) {
        const comment = await this.comments
            .findById(commentId)
            .lean<CommentLean>();
        if (!comment) {
            throw new NotFoundException('Comment not found!');
        }
        if (!(comment.likes || []).some((id) => String(id) === actor.id)) {
            throw new ConflictException('You have not liked this comment!');
        }
        const unliked = await this.comments
            .findByIdAndUpdate(
                commentId,
                { $pull: { likes: actor.id } },
                { returnDocument: 'after', runValidators: true },
            )
            .lean();
        await this.logger.action('unlike_comment', actor, {
            post: String(comment.post_id),
            post_title: await this.postTitle(comment.post_id),
            comment: commentId,
            comment_text: textPreview(comment.comment_text),
            comment_author: String(comment.author),
        });
        return unliked;
    }

    /** Заголовок поста для записи журнала: пост могут удалить, а запись останется. */
    private async postTitle(postId: unknown): Promise<string | null> {
        const post = await this.posts
            .findById(postId)
            .select('title')
            .lean<{ title?: string }>();
        return post?.title ?? null;
    }
}
