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
    provider: 'youtube' | 'vimeo' | 'dailymotion' | 'link';
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

export type ResolvedMedia = {
    items: MediaItem[];
    unused: Express.Multer.File[];
};
const MAX_URL_LENGTH = 2048;
const MAX_TEXT = 300;
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
    return {
        url: `https://www.dailymotion.com/video/${id}`,
        embed: {
            provider: 'dailymotion',
            embed_url: `https://www.dailymotion.com/embed/video/${id}`,
            thumbnail: `https://www.dailymotion.com/thumbnail/video/${id}`,
        },
    };
}

function clip(value: unknown): string | undefined {
    const text = typeof value === 'string' ? value.trim() : '';
    return text ? text.slice(0, MAX_TEXT) : undefined;
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
    ): Promise<MediaItem[] | undefined> {
        return (await this.resolveWithFiles(raw, files))?.items;
    }

    async resolveWithFiles(
        raw: unknown,
        files: Express.Multer.File[] = [],
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
                      ? await this.resolveEmbed(data)
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
            return { id: '', type: 'embed', url: canonical, embed };
        }
        if (kind.kind === 'file') {
            return { id: '', type: kind.type, url: url.href, external: true };
        }

        try {
            const preview = await this.previews.fetchPreview(url.href);
            if (preview.media_type) {
                return {
                    id: '',
                    type: preview.media_type,
                    url: preview.url,
                    external: true,
                };
            }
            return {
                id: '',
                type: 'embed',
                url: preview.url,
                embed: {
                    provider: 'link',
                    embed_url: preview.url,
                    title: clip(preview.title),
                    description: clip(preview.description),
                    thumbnail: parseExternalUrl(preview.image)?.href,
                },
            };
        } catch {
            throw fieldError(
                'media',
                'This link cannot be embedded!',
                url.href,
            );
        }
    }
}
