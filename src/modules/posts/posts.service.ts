import {
    ConflictException,
    ForbiddenException,
    Injectable,
    InternalServerErrorException,
    NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PERMISSIONS } from '../../authz/permissions';
import { hasPermission, isResourceOwner, type Actor } from '../../authz/policy';
import { FilesService } from '../../files/files.service';
import {
    MEDIA_PREFIXES,
    MediaService,
    legacyMedia,
    presentPost,
    type MediaItem,
} from './media';
import {
    hasMediaMarkup,
    htmlToText,
    ownMediaUrls,
    postExcerpt,
    sanitizePostHtml,
} from './post-html';
import { discardFiles } from '../../files/post-uploads.interceptor';
import { LoggerService } from '../../infra/logger.service';
import { changeOf, compact } from '../../infra/log-helpers';
import { parsePagination } from '../../http/pagination';
import type { ListPostsQueryDto } from '../../http/query.dto';
import { fieldError } from '../../http/http-errors';
import { isMongoObjectId } from '../../http/mongo-id';
import { Post, type PostDocument } from '../../database/schemas/post.schema';
import { PostComment } from '../../database/schemas/post-comment.schema';
import { UsersService } from '../users/users.service';
import { CommentsService } from './comments.service';
import { tryConsume } from '../../http/rate-limit.guard';
import { NotificationsService } from '../notifications/notifications.service';
import { MentionNotificationsService } from '../notifications/mention-notifications.service';

@Injectable()
export class PostsService {
    constructor(
        @InjectModel(Post.name) private readonly posts: Model<Post>,
        @InjectModel(PostComment.name)
        private readonly comments: Model<PostComment>,
        private readonly commentsService: CommentsService,
        private readonly usersService: UsersService,
        private readonly notifications: NotificationsService,
        private readonly mentionNotifications: MentionNotificationsService,
        private readonly files: FilesService,
        private readonly media: MediaService,
        private readonly logger: LoggerService,
    ) {}

    private cleanContent(html: string | undefined): string {
        return sanitizePostHtml(html ?? '', (url) =>
            this.files.ownUploadPath(url, MEDIA_PREFIXES),
        );
    }

    private assertHasBody(content: string, media: MediaItem[]) {
        if (media.length || htmlToText(content) || hasMediaMarkup(content)) {
            return;
        }
        throw fieldError(
            'postContent',
            'Add some text or media to your post!',
            content,
        );
    }

    private mediaUrlsOf(post: {
        media?: MediaItem[] | null;
        featured_image?: string | null;
        content_text?: string | null;
    }): string[] {
        const raw = [
            ...legacyMedia(post).flatMap((item) =>
                item.external
                    ? []
                    : [item.url, ...(item.poster ? [item.poster] : [])],
            ),
            ...ownMediaUrls(post.content_text),
        ];
        const urls = raw
            .map((url) => this.files.ownUploadPath(url, MEDIA_PREFIXES))
            .filter((url): url is string => Boolean(url));
        return [...new Set(urls)];
    }
    private async releaseMedia(urls: string[], exceptPostId?: string) {
        for (const url of urls) {
            const referenced = await this.posts.exists({
                ...(exceptPostId ? { _id: { $ne: exceptPostId } } : {}),
                $or: [
                    { 'media.url': url },
                    { 'media.poster': url },
                    { featured_image: url },
                    {
                        content_text: {
                            $regex: url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
                        },
                    },
                ],
            });
            if (!referenced) await this.files.remove(url);
        }
    }

    private objectId(value?: string | string[], field = 'id') {
        if (value == null || value === '') return undefined;
        const ids = (Array.isArray(value) ? value : [value])
            .flatMap((item) => String(item).split(','))
            .map((item) => item.trim())
            .filter(Boolean);
        if (!ids.length) return undefined;
        const parsed = ids.map((id) => {
            if (!isMongoObjectId(id)) {
                throw fieldError(field, 'Incorrect type!', id);
            }
            return new Types.ObjectId(id);
        });
        if (parsed.length === 1) return parsed[0];
        return { $in: parsed };
    }

    private assertOwnerOrPermission(
        resourceAuthorId: unknown,
        actor: Actor,
        permission: (typeof PERMISSIONS)[keyof typeof PERMISSIONS],
        message: string,
    ) {
        if (
            isResourceOwner(resourceAuthorId, actor.id) ||
            hasPermission(actor, permission)
        ) {
            return;
        }
        throw new ForbiddenException(message);
    }

    async list(query: ListPostsQueryDto): Promise<{
        items: Record<string, unknown>[];
        pagination: {
            page: number;
            limit: number;
            total: number;
            pages: number;
        };
    }> {
        const { page, limit, skip } = parsePagination(query, 5, 50);
        const filter: Record<string, unknown> = {};
        const author = this.objectId(query.author, 'author');
        if (author) filter.author = author;
        if (query._id || query.ids || query.id) {
            const idsValue = query._id || query.ids || query.id;
            if (!String(idsValue || '').trim()) {
                return {
                    items: [],
                    pagination: { page, limit, total: 0, pages: 0 },
                };
            }
            filter._id = this.objectId(idsValue, 'id');
        }

        const total = await this.posts.countDocuments(filter);
        const items = await this.posts
            .find(filter)
            .sort({ created_date: -1 })
            .skip(skip)
            .limit(limit)
            .lean();
        const expand = String(query.expand || '')
            .split(',')
            .map((item) => item.trim())
            .filter(Boolean);
        const commentsByPost = await this.commentsService.forPosts(
            items.map((post) => post._id),
        );
        const commentCounts = await this.commentsService.countsByPost(
            items.map((post) => post._id),
        );

        let authorMap = new Map<string, unknown>();
        if (expand.includes('author')) {
            const authors = await this.usersService.getPublicByIds(
                items.map((post) => post.author),
            );
            authorMap = new Map(
                authors.map((item) => [String(item._id), item]),
            );
        }

        return {
            items: items.map((post) => ({
                ...presentPost(post),
                comments: commentsByPost.get(String(post._id)) || [],
                comments_count: commentCounts.get(String(post._id)) || 0,
                views_count: Number(post.views_count || 0),
                author: expand.includes('author')
                    ? authorMap.get(String(post.author)) || null
                    : post.author,
            })) as Record<string, unknown>[],
            pagination: {
                page,
                limit,
                total,
                pages: total > 0 ? Math.ceil(total / limit) : 0,
            },
        };
    }

    async getById(
        id: string,
        expand?: string,
        view?: { viewerKey?: string; count?: boolean },
    ) {
        const post = await this.posts.findById(id).lean();
        if (!post) {
            throw new NotFoundException('Post not found!');
        }
        let viewsCount = Number(post.views_count || 0);
        if (view?.count && view.viewerKey) {
            viewsCount = await this.recordView(id, view.viewerKey, viewsCount);
        }
        const flags = String(expand || '')
            .split(',')
            .map((item) => item.trim());
        const comments = await this.commentsService.listForPost(
            id,
            flags.includes('comments') ? 'author' : undefined,
        );
        const commentsCount = await this.comments.countDocuments({
            post_id: { $in: [post._id, String(post._id)] },
        });
        const result: Record<string, unknown> = {
            ...presentPost(post),
            comments,
            comments_count: commentsCount,
            views_count: viewsCount,
        };
        if (flags.includes('author')) {
            const authors = await this.usersService.getPublicByIds([
                post.author,
            ]);
            result.author = authors[0] || null;
        }
        return result;
    }

    private async recordView(
        postId: string,
        viewerKey: string,
        current: number,
    ) {
        if (!tryConsume(`post-view:${viewerKey}:${postId}`, 60_000, 20)) {
            return current;
        }
        await this.posts.updateOne(
            { _id: postId },
            { $inc: { views_count: 1 } },
        );
        return current + 1;
    }

    async create(
        data: { postContent?: string; media?: unknown },
        files: Express.Multer.File[],
        actor: Actor,
    ) {
        let content: string;
        let media: MediaItem[];
        let unused: Express.Multer.File[];
        let created: PostDocument;
        try {
            if (!hasPermission(actor, PERMISSIONS.CREATE_POST)) {
                throw new ForbiddenException(
                    "You don't have permission to create a post",
                );
            }

            const resolved = await this.media.resolveWithFiles(
                data.media,
                files,
            );
            media = resolved?.items ?? [];
            unused = resolved ? resolved.unused : files;
            content = this.cleanContent(data.postContent);
            this.assertHasBody(content, media);

            created = await this.posts.create({
                author: actor.id,
                content_text: content,
                media,
            });
        } catch (error) {
            await discardFiles(files);
            throw error;
        }
        await discardFiles(unused);
        await this.logger.action(
            'create_post',
            actor,
            {
                post: created._id,
                post_title: postExcerpt(content),
                has_image: media.length > 0,
                media_count: media.length,
                content_length: content.length,
            },
            `User ${actor.nick_name} created post`,
        );
        await this.mentionNotifications.notifyFromText({
            actorId: actor.id,
            text: content,
            postId: String(created._id),
        });
        return presentPost(created.toObject());
    }
    private findPostForEdit(id: string) {
        return this.posts.findById(id).lean();
    }

    async edit(
        id: string,
        data: { postContent?: string; media?: unknown },
        files: Express.Multer.File[],
        actor: Actor,
    ) {
        let post: Awaited<ReturnType<typeof this.findPostForEdit>>;
        let result: Awaited<ReturnType<typeof this.findPostForEdit>>;
        let content: string;
        let media: MediaItem[];
        let previousMedia: MediaItem[];
        let resolved: MediaItem[] | undefined;
        let unused: Express.Multer.File[];
        try {
            post = await this.findPostForEdit(id);
            if (!post) {
                throw new NotFoundException('Post not found!');
            }
            this.assertOwnerOrPermission(
                post.author,
                actor,
                PERMISSIONS.EDIT_ANY_POST,
                "You don't have permission to update a post",
            );

            const update: Record<string, unknown> = {};
            const unset: Record<string, 1> = {};
            content = String(post.content_text ?? '');
            if (data.postContent !== undefined) {
                content = this.cleanContent(data.postContent);
                update.content_text = content;
            }

            previousMedia = legacyMedia(post);
            media = previousMedia;
            const withFiles = await this.media.resolveWithFiles(
                data.media,
                files,
            );
            resolved = withFiles?.items;
            unused = withFiles ? withFiles.unused : files;
            if (resolved !== undefined) {
                media = resolved;
                update.media = resolved;
                if (post.featured_image) unset.featured_image = 1;
            }
            if ('title' in post) unset.title = 1;
            if (data.postContent !== undefined || resolved !== undefined) {
                this.assertHasBody(content, media);
            }

            result = await this.posts
                .findByIdAndUpdate(
                    id,
                    {
                        $set: update,
                        ...(Object.keys(unset).length ? { $unset: unset } : {}),
                    },
                    { returnDocument: 'after' },
                )
                .lean();
            if (!result) {
                throw new NotFoundException('Post not found!');
            }
        } catch (error) {
            await discardFiles(files);
            throw error;
        }
        await discardFiles(unused);
        const keep = new Set(this.mediaUrlsOf(result));
        await this.releaseMedia(
            this.mediaUrlsOf(post).filter((url) => !keep.has(url)),
            id,
        );

        const mediaChange =
            resolved === undefined ||
            previousMedia.map((item) => item.url).join('|') ===
                media.map((item) => item.url).join('|')
                ? null
                : !media.length
                  ? 'removed'
                  : previousMedia.length
                    ? 'changed'
                    : 'added';
        const changes = compact([
            mediaChange ? { field: 'image', to: mediaChange } : null,
            data.postContent !== undefined &&
            String(post.content_text ?? '') !== content
                ? {
                      field: 'content',
                      changed: true,
                      from_length: String(post.content_text ?? '').length,
                      to_length: content.length,
                  }
                : null,
        ]);
        if (changes.length) {
            await this.logger.action(
                'update_post',
                actor,
                {
                    post: result._id,
                    post_title: postExcerpt(content),
                    changes,
                    ...(isResourceOwner(post.author, actor.id)
                        ? {}
                        : {
                              moderation: true,
                              post_author: String(post.author),
                          }),
                },
                `User ${actor.nick_name} updated post ${post._id}`,
            );
        }
        if (data.postContent !== undefined) {
            await this.mentionNotifications.notifyNewMentions(
                String(post.content_text || ''),
                content,
                {
                    actorId: actor.id,
                    postId: id,
                },
            );
        }
        return presentPost(result);
    }
    async remove(id: string, actor: Actor) {
        const post = await this.posts.findById(id).lean();
        if (!post) {
            throw new NotFoundException('Post not found!');
        }
        this.assertOwnerOrPermission(
            post.author,
            actor,
            PERMISSIONS.DELETE_ANY_POST,
            "You don't have permission to delete a post",
        );

        await this.usersService.removePostFromSavedForUsers(id);
        const comments = await this.comments
            .find({ post_id: { $in: [id, new Types.ObjectId(id)] } })
            .lean();
        const commentIds = comments.map((comment) => comment._id);
        if (commentIds.length) {
            await this.comments.deleteMany({ _id: { $in: commentIds } });
        }

        const result = await this.posts.findByIdAndDelete(id).lean();
        if (!result) {
            throw new InternalServerErrorException('Failed to delete post!');
        }
        await this.releaseMedia(this.mediaUrlsOf(result), id);

        if (commentIds.length) {
            await this.usersService.removeNotifications({
                type: { $in: ['reply_comment', 'like_comment'] },
                comment: { $in: commentIds },
            });
        }
        await this.usersService.removeNotifications({
            type: { $in: ['like_post', 'comment_post'] },
            post: id,
        });
        await this.logger.action(
            'delete_post',
            actor,
            {
                post: result._id,
                post_title: postExcerpt(result.content_text),
                post_author: String(result.author),
                comments_removed: commentIds.length,
                likes_count: (result.likes ?? []).length,
                views_count: result.views_count ?? 0,
                ...(isResourceOwner(result.author, actor.id)
                    ? {}
                    : { moderation: true }),
            },
            `User ${actor.nick_name} deleted post ${id}`,
        );
        return presentPost(result);
    }

    async save(id: string, actor: Actor) {
        const post = await this.posts.findById(id).lean();
        if (!post) {
            throw new NotFoundException('Post not found!');
        }
        const user = await this.usersService.getById(actor.id, {
            withSavedPosts: true,
        });
        if (!user) {
            throw new NotFoundException('User not found!');
        }
        if ((user.saved_posts || []).some((item) => String(item) === id)) {
            throw new ConflictException('Post is already in saved posts!');
        }
        const result = await this.usersService.addSavedPost(actor.id, id);
        await this.logger.action('save_post', actor, {
            post: id,
            post_title: postExcerpt(post.content_text),
        });
        return { saved_posts: result?.saved_posts };
    }

    async unsave(id: string, actor: Actor) {
        const post = await this.posts.findById(id).lean();
        if (!post) {
            throw new NotFoundException('Post not found!');
        }
        const user = await this.usersService.getById(actor.id, {
            withSavedPosts: true,
        });
        if (!user) {
            throw new NotFoundException('User not found!');
        }
        if (!(user.saved_posts || []).some((item) => String(item) === id)) {
            throw new ConflictException('Post is not in saved posts!');
        }
        const result = await this.usersService.removeSavedPost(actor.id, id);
        await this.logger.action('unsave_post', actor, {
            post: id,
            post_title: postExcerpt(post.content_text),
        });
        return { saved_posts: result?.saved_posts };
    }

    async like(id: string, actor: Actor) {
        const post = await this.posts.findById(id).lean();
        if (!post) {
            throw new NotFoundException('Post not found!');
        }
        if ((post.likes || []).some((like) => String(like) === actor.id)) {
            throw new ConflictException('Post is already liked!');
        }
        const result = await this.posts
            .findByIdAndUpdate(
                id,
                { $addToSet: { likes: actor.id } },
                { returnDocument: 'after' },
            )
            .lean();
        if (String(post.author) !== actor.id) {
            await this.notifications.sendNotification(String(post.author), {
                type: 'like_post',
                user: actor.id,
                post: id,
            });
        }
        await this.logger.action(
            'like_post',
            actor,
            {
                post: id,
                post_title: postExcerpt(post.content_text),
                post_author: String(post.author),
            },
            `User ${actor.nick_name} liked post ${id}`,
        );
        return { likes: result?.likes };
    }

    async unlike(id: string, actor: Actor) {
        const post = await this.posts.findById(id).lean();
        if (!post) {
            throw new NotFoundException('Post not found!');
        }
        if (!(post.likes || []).some((like) => String(like) === actor.id)) {
            throw new ConflictException('Post is not liked!');
        }
        const result = await this.posts
            .findByIdAndUpdate(
                id,
                { $pull: { likes: actor.id } },
                { returnDocument: 'after' },
            )
            .lean();
        await this.logger.action('unlike_post', actor, {
            post: id,
            post_title: postExcerpt(post.content_text),
            post_author: String(post.author),
        });
        return { likes: result?.likes };
    }
}
