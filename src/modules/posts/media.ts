import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { FilesService } from '../../files/files.service';
import {
    POST_MEDIA_DIR,
    POST_MEDIA_LIMIT_SIZE,
    type PostMediaKind,
} from '../../files/upload';
import { fieldError } from '../../http/http-errors';
import { LinkPreviewService } from '../link-preview/link-preview.service';
import { postExcerpt } from './post-html';

export type MediaType = 'image' | 'gif' | 'video' | 'embed';

export type MediaEmbed = {
    provider: 'youtube' | 'vimeo' | 'dailymotion' | 'twitch' | 'link';
    embed_url: string;
    title?: string;
    description?: string;
    thumbnail?: string;
};

export type MediaItem = {
    id: string;
    type: MediaType;
    url: string;
    poster?: string;
    width?: number;
    height?: number;
    size?: number;
    external?: true;
    embed?: MediaEmbed;
};

export const MEDIA_PREFIXES = [POST_MEDIA_DIR, 'src/featured_image'];
export const MAX_MEDIA_ITEMS = 10;
export const MEDIA_TOTAL_ERROR = 'Media in one post cannot exceed 100 MB';
export const MEDIA_FILE_MISSING_ERROR =
    'Media file was not uploaded with the post!';
export const MEDIA_LINK_UNSUPPORTED_ERROR =
    'Only image, video, YouTube, Vimeo or Twitch links can be added as media. Paste other links into the text.';

export type ResolvedMedia = {
    items: MediaItem[];
    unused: Express.Multer.File[];
};
const MAX_URL_LENGTH = 2048;
const MAX_DIMENSION = 20_000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,40}$/;

const FILE_TYPES: Record<string, PostMediaKind> = {
    '.mp4': 'video',
    '.webm': 'video',
    '.mov': 'video',
    '.gif': 'gif',
    '.png': 'image',
    '.jpg': 'image',
    '.jpeg': 'image',
    '.webp': 'image',
    '.avif': 'image',
};

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const NUMERIC_ID = /^\d{5,}$/;
const DAILYMOTION_ID = /^[A-Za-z0-9]{4,12}$/;
const TWITCH_VIDEO_ID = /^\d{5,}$/;
const TWITCH_LOGIN = /^[A-Za-z0-9_]{3,25}$/;
const TWITCH_CLIP_SLUG = /^[A-Za-z0-9_-]{3,100}$/;
const TWITCH_RESERVED = new Set([
    'directory',
    'videos',
    'settings',
    'p',
    'downloads',
    'jobs',
    'turbo',
    'store',
    'subscriptions',
    'wallet',
    'friends',
    'messages',
    'drops',
    'search',
    'popout',
    'embed',
    'clip',
    'moderator',
    'u',
    'user',
    'broadcast',
]);

export type TwitchTarget = {
    kind: 'video' | 'clip' | 'channel';
    id: string;
};

export function mediaTypeOfPath(pathname: string): PostMediaKind | null {
    const dot = pathname.lastIndexOf('.');
    if (dot < 0) return null;
    return FILE_TYPES[pathname.slice(dot).toLowerCase()] ?? null;
}

export function legacyMedia(post: {
    media?: MediaItem[] | null;
    featured_image?: string | null;
}): MediaItem[] {
    if (post.media?.length) return post.media;
    if (post.featured_image) {
        return [{ id: 'legacy', type: 'image', url: post.featured_image }];
    }
    return [];
}

export function presentPost<T extends object>(
    post: T,
): Omit<T, 'featured_image' | 'title' | 'media'> & {
    media: MediaItem[];
    excerpt: string;
} {
    const { featured_image, title, media, ...rest } = post as T & {
        featured_image?: string | null;
        title?: string | null;
        media?: MediaItem[] | null;
        content_text?: string | null;
    };
    const content = (post as { content_text?: string | null }).content_text;
    return {
        ...(rest as Omit<T, 'featured_image' | 'title' | 'media'>),
        media: legacyMedia({ media, featured_image }),
        excerpt: postExcerpt(content) || postExcerpt(title ?? ''),
    };
}

export function parseExternalUrl(raw: unknown): URL | null {
    if (typeof raw !== 'string') return null;
    const value = raw.trim();
    if (!value || value.length > MAX_URL_LENGTH) return null;
    try {
        const url = new URL(value);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
        if (url.username || url.password) return null;
        return url;
    } catch {
        return null;
    }
}

function twitchTarget(host: string, segments: string[]): TwitchTarget | null {
    if (host === 'clips.twitch.tv') {
        const slug = segments[0] === 'embed' ? undefined : segments[0];
        return slug && TWITCH_CLIP_SLUG.test(slug)
            ? { kind: 'clip', id: slug }
            : null;
    }
    const first = segments[0]?.toLowerCase();
    if (!first) return null;
    if (first === 'videos' && TWITCH_VIDEO_ID.test(segments[1] ?? '')) {
        return { kind: 'video', id: segments[1] };
    }
    if (TWITCH_RESERVED.has(first) || !TWITCH_LOGIN.test(segments[0])) {
        return null;
    }
    if (
        segments[1]?.toLowerCase() === 'clip' &&
        TWITCH_CLIP_SLUG.test(segments[2] ?? '')
    ) {
        return { kind: 'clip', id: segments[2] };
    }
    if (segments.length === 1) {
        return { kind: 'channel', id: segments[0].toLowerCase() };
    }
    return null;
}
export function classifyEmbedUrl(
    url: URL,
):
    | { kind: 'embed'; provider: MediaEmbed['provider']; id: string }
    | { kind: 'file'; type: PostMediaKind }
    | { kind: 'link' } {
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    const segments = url.pathname.split('/').filter(Boolean);

    if (host === 'youtu.be' && YOUTUBE_ID.test(segments[0] ?? '')) {
        return { kind: 'embed', provider: 'youtube', id: segments[0] };
    }
    if (
        host === 'youtube.com' ||
        host === 'm.youtube.com' ||
        host === 'music.youtube.com' ||
        host === 'youtube-nocookie.com'
    ) {
        const v = url.searchParams.get('v');
        if (v && YOUTUBE_ID.test(v)) {
            return { kind: 'embed', provider: 'youtube', id: v };
        }
        if (
            ['embed', 'shorts', 'live', 'v'].includes(segments[0]) &&
            YOUTUBE_ID.test(segments[1] ?? '')
        ) {
            return { kind: 'embed', provider: 'youtube', id: segments[1] };
        }
    }
    if (host === 'vimeo.com' || host === 'player.vimeo.com') {
        const id = segments.find((part) => NUMERIC_ID.test(part));
        if (id) return { kind: 'embed', provider: 'vimeo', id };
    }
    if (host === 'dailymotion.com' || host === 'geo.dailymotion.com') {
        const index = segments.indexOf('video');
        const id = index >= 0 ? segments[index + 1] : undefined;
        if (id && DAILYMOTION_ID.test(id.split('_')[0])) {
            return {
                kind: 'embed',
                provider: 'dailymotion',
                id: id.split('_')[0],
            };
        }
    }
    if (host === 'dai.ly' && DAILYMOTION_ID.test(segments[0] ?? '')) {
        return { kind: 'embed', provider: 'dailymotion', id: segments[0] };
    }

    if (['twitch.tv', 'm.twitch.tv', 'clips.twitch.tv'].includes(host)) {
        const target = twitchTarget(host, segments);
        if (target) {
            return {
                kind: 'embed',
                provider: 'twitch',
                id: `${target.kind}:${target.id}`,
            };
        }
    }
    const type = mediaTypeOfPath(url.pathname);
    if (type) return { kind: 'file', type };
    return { kind: 'link' };
}

function embedFor(
    provider: MediaEmbed['provider'],
    id: string,
): { url: string; embed: MediaEmbed } {
    if (provider === 'youtube') {
        return {
            url: `https://www.youtube.com/watch?v=${id}`,
            embed: {
                provider,
                embed_url: `https://www.youtube-nocookie.com/embed/${id}`,
                thumbnail: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
            },
        };
    }
    if (provider === 'vimeo') {
        return {
            url: `https://vimeo.com/${id}`,
            embed: {
                provider,
                embed_url: `https://player.vimeo.com/video/${id}`,
            },
        };
    }
    if (provider === 'twitch') {
        const sep = id.indexOf(':');
        const kind = id.slice(0, sep);
        const value = id.slice(sep + 1);
        if (kind === 'video') {
            return {
                url: `https://www.twitch.tv/videos/${value}`,
                embed: {
                    provider,
                    embed_url: `https://player.twitch.tv/?video=v${value}`,
                },
            };
        }
        if (kind === 'clip') {
            return {
                url: `https://clips.twitch.tv/${value}`,
                embed: {
                    provider,
                    embed_url: `https://clips.twitch.tv/embed?clip=${value}`,
                },
            };
        }
        return {
            url: `https://www.twitch.tv/${value}`,
            embed: {
                provider,
                embed_url: `https://player.twitch.tv/?channel=${value}`,
            },
        };
    }
    return {
        url: `https://www.dailymotion.com/video/${id}`,
        embed: {
            provider: 'dailymotion',
            embed_url: `https://www.dailymotion.com/embed/video/${id}`,
            thumbnail: `https://www.dailymotion.com/thumbnail/video/${id}`,
        },
    };
}

function dimension(value: unknown): number | undefined {
    const n = typeof value === 'string' ? Number(value) : value;
    if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
    const rounded = Math.round(n);
    return rounded >= 1 && rounded <= MAX_DIMENSION ? rounded : undefined;
}

@Injectable()
export class MediaService {
    constructor(
        private readonly files: FilesService,
        private readonly previews: LinkPreviewService,
    ) {}

    async resolve(
        raw: unknown,
        files: Express.Multer.File[] = [],
        existing: MediaItem[] = [],
    ): Promise<MediaItem[] | undefined> {
        return (await this.resolveWithFiles(raw, files, existing))?.items;
    }

    async resolveWithFiles(
        raw: unknown,
        files: Express.Multer.File[] = [],
        existing: MediaItem[] = [],
    ): Promise<ResolvedMedia | undefined> {
        if (raw === undefined) return undefined;
        if (raw === null || raw === '' || raw === 'null') {
            return { items: [], unused: [...files] };
        }

        let input: unknown = raw;
        if (typeof raw === 'string') {
            try {
                input = JSON.parse(raw);
            } catch {
                throw fieldError('media', 'Incorrect media!', raw);
            }
        }
        if (input === null) return { items: [], unused: [...files] };
        if (!Array.isArray(input)) {
            throw fieldError('media', 'Incorrect media!', raw);
        }
        if (input.length > MAX_MEDIA_ITEMS) {
            throw fieldError(
                'media',
                `A post can have at most ${MAX_MEDIA_ITEMS} media items!`,
                input.length,
            );
        }

        const items: MediaItem[] = [];
        const ids = new Set<string>();
        const sizes = new Map<string, number>();
        const byClientId = new Map<string, Express.Multer.File>();
        for (const file of files) {
            if (!byClientId.has(file.fieldname)) {
                byClientId.set(file.fieldname, file);
            }
        }
        const usedClientIds = new Set<string>();
        for (const entry of input) {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw fieldError('media', 'Incorrect media!', entry);
            }
            const data = entry as Record<string, unknown>;
            const item =
                data.upload !== undefined
                    ? await this.resolveNewUpload(
                          data,
                          byClientId,
                          usedClientIds,
                      )
                    : data.type === 'embed'
                      ? (this.keptLegacyCard(data, existing) ??
                        (await this.resolveEmbed(data)))
                      : await this.resolveUpload(data);
            let id =
                typeof data.id === 'string' && ID_PATTERN.test(data.id)
                    ? data.id
                    : randomUUID();
            if (ids.has(id)) id = randomUUID();
            ids.add(id);
            item.id = id;
            items.push(item);
            if (item.size && !sizes.has(item.url)) {
                sizes.set(item.url, item.size);
            }
        }

        let total = 0;
        for (const size of sizes.values()) total += size;
        if (total > POST_MEDIA_LIMIT_SIZE) {
            throw fieldError('media', MEDIA_TOTAL_ERROR, total);
        }
        const unused = files.filter(
            (file) =>
                byClientId.get(file.fieldname) !== file ||
                !usedClientIds.has(file.fieldname),
        );
        return { items, unused };
    }

    private async resolveNewUpload(
        data: Record<string, unknown>,
        byClientId: Map<string, Express.Multer.File>,
        used: Set<string>,
    ): Promise<MediaItem> {
        const clientId = typeof data.upload === 'string' ? data.upload : '';
        if (!ID_PATTERN.test(clientId) || used.has(clientId)) {
            throw fieldError('media', 'Incorrect media!', data.upload);
        }
        const file = byClientId.get(clientId);
        if (!file) {
            throw fieldError('media', MEDIA_FILE_MISSING_ERROR, clientId);
        }
        used.add(clientId);
        const stored = await this.files.finalizePostMedia(file);
        const item: MediaItem = {
            id: '',
            type: stored.type,
            url: stored.url,
            size: stored.size,
        };
        const width = dimension(data.width);
        const height = dimension(data.height);
        if (width && height) {
            item.width = width;
            item.height = height;
        }
        return item;
    }

    private async resolveUpload(
        data: Record<string, unknown>,
    ): Promise<MediaItem> {
        const url = this.files.ownUploadPath(data.url, MEDIA_PREFIXES);
        if (!url) {
            throw fieldError(
                'media',
                'Media file must be uploaded to Scribo first!',
                data.url,
            );
        }
        const type = mediaTypeOfPath(url);
        if (!type) {
            throw fieldError('media', 'Unsupported media file!', data.url);
        }
        const size = await this.files.uploadSize(url);
        if (size === null) {
            throw fieldError('media', 'Media file was not found!', data.url);
        }
        const item: MediaItem = { id: '', type, url, size };
        if (type === 'video' && data.poster !== undefined) {
            const poster = this.files.ownUploadPath(
                data.poster,
                MEDIA_PREFIXES,
            );
            if (!poster || mediaTypeOfPath(poster) !== 'image') {
                throw fieldError(
                    'media',
                    'Media poster must be an image uploaded to Scribo first!',
                    data.poster,
                );
            }
            item.poster = poster;
        }
        const width = dimension(data.width);
        const height = dimension(data.height);
        if (width && height) {
            item.width = width;
            item.height = height;
        }
        return item;
    }

    private async resolveEmbed(
        data: Record<string, unknown>,
    ): Promise<MediaItem> {
        const url = parseExternalUrl(data.url);
        if (!url) {
            throw fieldError(
                'media',
                'Media link must be a valid http(s) URL!',
                data.url,
            );
        }
        const kind = classifyEmbedUrl(url);

        if (kind.kind === 'embed') {
            const { url: canonical, embed } = embedFor(kind.provider, kind.id);
            if (kind.provider === 'twitch') {
                const thumbnail = await this.twitchThumbnail(canonical);
                if (thumbnail) embed.thumbnail = thumbnail;
            }
            return { id: '', type: 'embed', url: canonical, embed };
        }
        if (kind.kind === 'file') {
            return { id: '', type: kind.type, url: url.href, external: true };
        }

        let sniffed: MediaType | null = null;
        try {
            sniffed =
                (await this.previews.fetchPreview(url.href)).media_type ?? null;
        } catch {
            sniffed = null;
        }
        if (sniffed) {
            return { id: '', type: sniffed, url: url.href, external: true };
        }
        throw fieldError('media', MEDIA_LINK_UNSUPPORTED_ERROR, url.href);
    }

    private keptLegacyCard(
        data: Record<string, unknown>,
        existing: MediaItem[],
    ): MediaItem | null {
        const embed = data.embed as { provider?: unknown } | undefined;
        if (embed?.provider !== 'link') return null;
        const stored = existing.find(
            (item) =>
                item.type === 'embed' &&
                item.embed?.provider === 'link' &&
                item.url === data.url &&
                (typeof data.id !== 'string' || item.id === data.id),
        );
        return stored ? { ...stored } : null;
    }

    private async twitchThumbnail(url: string): Promise<string | undefined> {
        try {
            const preview = await Promise.race([
                this.previews.fetchPreview(url),
                new Promise<null>((resolve) =>
                    setTimeout(() => resolve(null), 2500),
                ),
            ]);
            return parseExternalUrl(preview?.image)?.href;
        } catch {
            return undefined;
        }
    }
}
