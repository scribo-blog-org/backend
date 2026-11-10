import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Post } from '../../database/schemas/post.schema';
import { PostComment } from '../../database/schemas/post-comment.schema';
import { User } from '../../database/schemas/user.schema';
import { UsersService } from '../users/users.service';
import { SearchQueryLog } from '../../database/schemas/search-query.schema';
import { legacyMedia, type MediaItem } from '../posts/media';
import { postExcerpt } from '../posts/post-html';

const RESULT_LIMIT = 8;
const CANDIDATE_LIMIT = 40;
const MIN_QUERY = 2;
const SNIPPET = 140;
const SEARCH_DEDUPE_MS = 8000;

function escapeRegex(value: string) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripHtml(html: string) {
    return html
        .replace(/<[^>]+>/g, ' ')
        .replace(/&[a-zA-Z0-9#]+;/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function normalizeQuery(raw: string) {
    return raw.trim().replace(/\s+/g, ' ').toLowerCase();
}

function containsNeedle(text: string, needle: string) {
    if (!needle) {
        return false;
    }
    return stripHtml(text).toLowerCase().includes(needle);
}

function snippetAround(text: string, needle: string) {
    const plain = stripHtml(text);
    if (!plain) {
        return '';
    }
    const at = plain.toLowerCase().indexOf(needle);
    if (at < 0) {
        return plain.length > SNIPPET
            ? `${plain.slice(0, SNIPPET).trim()}…`
            : plain;
    }
    const start = Math.max(0, at - 32);
    const end = Math.min(plain.length, at + needle.length + SNIPPET - 32);
    const slice = plain.slice(start, end).trim();
    return `${start > 0 ? '…' : ''}${slice}${end < plain.length ? '…' : ''}`;
}

function fieldRegex(needle: string) {
    return { $regex: escapeRegex(needle), $options: 'i' };
}

const HASHTAG_RE = /#[^\s#]+/g;

function extractHashtags(text: string) {
    const plain = stripHtml(String(text || '')).toLowerCase();
    return plain.match(HASHTAG_RE) || [];
}

function isHashtagQuery(needle: string) {
    return /^#[^\s#]+$/.test(needle);
}

function hasExactHashtag(text: string, tag: string) {
    const needle = tag.toLowerCase();
    return extractHashtags(text).some((item) => item === needle);
}

@Injectable()
export class SearchService {
    constructor(
        @InjectModel(Post.name) private readonly posts: Model<Post>,
        @InjectModel(PostComment.name)
        private readonly comments: Model<PostComment>,
        @InjectModel(User.name) private readonly users: Model<User>,
        @InjectModel(SearchQueryLog.name)
        private readonly searchLogs: Model<SearchQueryLog>,
        private readonly usersService: UsersService,
    ) {}

    async suggestHashtags(raw?: string) {
        const needle = normalizeQuery(String(raw || ''));
        const prefix = needle.startsWith('#') ? needle : `#${needle}`;
        if (prefix.length < MIN_QUERY) {
            return [];
        }

        const [docs, commentDocs] = await Promise.all([
            this.posts
                .find({
                    $or: [{ content_text: fieldRegex(prefix) }],
                })
                .select('content_text')
                .limit(CANDIDATE_LIMIT)
                .lean(),
            this.comments
                .find({ comment_text: fieldRegex(prefix) })
                .select('comment_text')
                .limit(CANDIDATE_LIMIT)
                .lean(),
        ]);

        const counts = new Map<string, number>();
        for (const doc of docs) {
            for (const tag of extractHashtags(`${doc.content_text || ''}`)) {
                if (tag.startsWith(prefix)) {
                    counts.set(tag, (counts.get(tag) || 0) + 1);
                }
            }
        }
        for (const doc of commentDocs) {
            for (const tag of extractHashtags(doc.comment_text || '')) {
                if (tag.startsWith(prefix)) {
                    counts.set(tag, (counts.get(tag) || 0) + 1);
                }
            }
        }

        return [...counts.entries()]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ru'))
            .slice(0, RESULT_LIMIT)
            .map(([tag]) => tag);
    }

    async search(raw?: string, meta?: { ip?: string }) {
        const needle = normalizeQuery(String(raw || ''));
        if (needle.length < MIN_QUERY) {
            return { posts: [], users: [] };
        }

        const payload = isHashtagQuery(needle)
            ? await this.searchHashtag(needle)
            : await this.searchText(needle);

        void this.logQuery(needle, payload, meta);
        return payload;
    }

    private async searchHashtag(needle: string) {
        const postDocs = await this.posts
            .find({
                $or: [{ content_text: fieldRegex(needle) }],
            })
            .sort({ created_date: -1 })
            .limit(CANDIDATE_LIMIT)
            .lean();

        const postsFiltered = postDocs
            .filter((post) =>
                hasExactHashtag(`${post.content_text || ''}`, needle),
            )
            .slice(0, RESULT_LIMIT);

        return this.toSearchPayload(postsFiltered, [], needle);
    }

    private async searchText(needle: string) {
        const parts = needle.split(' ').filter(Boolean);
        const postMatch =
            parts.length === 1
                ? {
                      $or: [{ content_text: fieldRegex(parts[0]) }],
                  }
                : {
                      $and: parts.map((part) => ({
                          $or: [{ content_text: fieldRegex(part) }],
                      })),
                  };

        const userMatch = {
            $or: [
                { nick_name: fieldRegex(needle) },
                { description: fieldRegex(needle) },
            ],
        };

        const [postDocs, userDocs] = await Promise.all([
            this.posts
                .find(postMatch)
                .sort({ created_date: -1 })
                .limit(CANDIDATE_LIMIT)
                .lean(),
            this.users
                .find(userMatch)
                .select('_id nick_name avatar is_verified description')
                .limit(CANDIDATE_LIMIT)
                .lean(),
        ]);

        const postsFiltered = postDocs
            .filter((post) =>
                containsNeedle(`${post.content_text || ''}`, needle),
            )
            .slice(0, RESULT_LIMIT);
        const usersFiltered = userDocs
            .filter(
                (user) =>
                    containsNeedle(user.nick_name, needle) ||
                    containsNeedle(user.description || '', needle),
            )
            .slice(0, RESULT_LIMIT);

        return this.toSearchPayload(postsFiltered, usersFiltered, needle);
    }

    private async logQuery(
        needle: string,
        payload: {
            posts: unknown[];
            users: unknown[];
        },
        meta?: { ip?: string },
    ) {
        try {
            const ip = String(meta?.ip || '').slice(0, 64);
            const recent = await this.searchLogs
                .findOne({
                    query: needle,
                    ip,
                    created_at: {
                        $gte: new Date(Date.now() - SEARCH_DEDUPE_MS),
                    },
                })
                .select('_id')
                .lean();
            if (recent) {
                return;
            }
            const posts = payload.posts?.length || 0;
            const users = payload.users?.length || 0;
            await this.searchLogs.create({
                query: needle.slice(0, 80),
                kind: isHashtagQuery(needle) ? 'hashtag' : 'text',
                hits: posts + users,
                posts,
                users,
                ip,
            });
        } catch {
            return;
        }
    }

    private async toSearchPayload(
        postsFiltered: Array<{
            _id: unknown;
            author: Types.ObjectId;
            content_text?: string;
            featured_image?: string | null;
            media?: MediaItem[] | null;
            created_date?: Date;
        }>,
        usersFiltered: unknown[],
        needle = '',
    ) {
        const authors = await this.usersService.getPublicByIds(
            postsFiltered.map((post) => post.author as Types.ObjectId),
        );
        const authorMap = new Map(
            authors.map((item) => [String(item._id), item]),
        );

        return {
            posts: postsFiltered.map((post) => ({
                _id: post._id,
                excerpt: postExcerpt(post.content_text),
                media: legacyMedia(post),
                created_date: post.created_date,
                snippet: snippetAround(
                    containsNeedle(String(post.content_text || ''), needle)
                        ? String(post.content_text || '')
                        : postExcerpt(post.content_text),
                    needle,
                ),
                author: authorMap.get(String(post.author)) || null,
            })),
            users: usersFiltered,
        };
    }
}
