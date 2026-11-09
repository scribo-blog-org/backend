import type { FilesService } from '../../files/files.service';
import { POST_MEDIA_LIMIT_SIZE } from '../../files/upload';
import type { LinkPreviewService } from '../link-preview/link-preview.service';
import {
    MEDIA_TOTAL_ERROR,
    MediaService,
    classifyEmbedUrl,
    legacyMedia,
    presentPost,
} from './media';

const MB = 1024 * 1024;

function build(
    sizes: Record<string, number> = {},
    preview = jest.fn().mockResolvedValue({
        url: 'https://example.com/page',
        title: 'Example',
        description: 'Desc',
        image: 'https://example.com/og.png',
        site_name: 'example.com',
    }),
) {
    const files = {
        ownUploadPath: (url: unknown) =>
            typeof url === 'string' &&
            url.startsWith('/uploads/src/post_media/')
                ? url
                : null,
        uploadSize: async (url: string) => sizes[url] ?? null,
    } as unknown as FilesService;
    const previews = { fetchPreview: preview } as unknown as LinkPreviewService;
    return { service: new MediaService(files, previews), preview };
}

const up = (name: string) => `/uploads/src/post_media/${name}`;

describe('MediaService.resolve', () => {
    it('leaves media untouched when the field is missing', async () => {
        expect(await build().service.resolve(undefined)).toBeUndefined();
    });

    it('clears media for null, empty string and []', async () => {
        const { service } = build();
        expect(await service.resolve(null)).toEqual([]);
        expect(await service.resolve('')).toEqual([]);
        expect(await service.resolve('[]')).toEqual([]);
    });

    it('accepts uploaded files, reads the real size and derives the type', async () => {
        const { service } = build({
            [up('a.jpg')]: 1234,
            [up('b.gif')]: 99,
            [up('c.mp4')]: 5000,
            [up('p.webp')]: 10,
        });
        const items = await service.resolve(
            JSON.stringify([
                { type: 'video', url: up('a.jpg'), size: 1 },
                { type: 'image', url: up('b.gif') },
                { type: 'image', url: up('c.mp4'), poster: up('p.webp') },
            ]),
        );
        expect(items?.map((item) => [item.type, item.size])).toEqual([
            ['image', 1234],
            ['gif', 99],
            ['video', 5000],
        ]);
        expect(items?.[2].poster).toBe(up('p.webp'));
        expect(new Set(items?.map((item) => item.id)).size).toBe(3);
    });

    it('rejects files that are not stored uploads', async () => {
        const { service } = build();
        await expect(
            service.resolve([{ type: 'image', url: 'https://evil.com/a.png' }]),
        ).rejects.toMatchObject({
            response: {
                message: 'Media file must be uploaded to Scribo first!',
            },
        });
    });

    it('rejects uploads that do not exist on disk', async () => {
        const { service } = build();
        await expect(
            service.resolve([{ type: 'image', url: up('ghost.png') }]),
        ).rejects.toMatchObject({
            response: { message: 'Media file was not found!' },
        });
    });

    it('rejects more than 10 items', async () => {
        const { service } = build();
        const many = Array.from({ length: 11 }, () => ({
            type: 'embed',
            url: 'https://youtu.be/dQw4w9WgXcQ',
        }));
        await expect(service.resolve(many)).rejects.toMatchObject({
            response: { message: 'A post can have at most 10 media items!' },
        });
    });

    it('sums the real stored sizes and rejects more than 100 MB', async () => {
        const { service } = build({
            [up('a.mp4')]: 60 * MB,
            [up('b.mp4')]: 41 * MB,
        });
        await expect(
            service.resolve([
                { type: 'video', url: up('a.mp4'), size: 1 },
                { type: 'video', url: up('b.mp4'), size: 1 },
            ]),
        ).rejects.toMatchObject({ response: { message: MEDIA_TOTAL_ERROR } });
        expect(MEDIA_TOTAL_ERROR).toBe(
            'Media in one post cannot exceed 100 MB',
        );
    });

    it('allows exactly the total limit', async () => {
        const { service } = build({
            [up('a.mp4')]: POST_MEDIA_LIMIT_SIZE / 2,
            [up('b.mp4')]: POST_MEDIA_LIMIT_SIZE / 2,
        });
        const items = await service.resolve([
            { type: 'video', url: up('a.mp4') },
            { type: 'video', url: up('b.mp4') },
        ]);
        expect(items).toHaveLength(2);
    });

    it('rejects a poster that is not an uploaded image', async () => {
        const { service } = build({ [up('a.mp4')]: 1, [up('b.mp4')]: 1 });
        await expect(
            service.resolve([
                { type: 'video', url: up('a.mp4'), poster: up('b.mp4') },
            ]),
        ).rejects.toMatchObject({
            response: {
                message:
                    'Media poster must be an image uploaded to Scribo first!',
            },
        });
    });

    it('turns YouTube links into a privacy-friendly embed without fetching', async () => {
        const { service, preview } = build();
        const [item] = (await service.resolve([
            {
                type: 'embed',
                url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=5',
            },
        ]))!;
        expect(item).toMatchObject({
            type: 'embed',
            url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
            embed: {
                provider: 'youtube',
                embed_url: 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
            },
        });
        expect(preview).not.toHaveBeenCalled();
    });

    it('turns Vimeo and Dailymotion links into embeds', async () => {
        const { service } = build();
        const items = (await service.resolve([
            { type: 'embed', url: 'https://vimeo.com/76979871' },
            { type: 'embed', url: 'https://www.dailymotion.com/video/x8abcd1' },
        ]))!;
        expect(items[0].embed).toMatchObject({
            provider: 'vimeo',
            embed_url: 'https://player.vimeo.com/video/76979871',
        });
        expect(items[1].embed).toMatchObject({
            provider: 'dailymotion',
            embed_url: 'https://www.dailymotion.com/embed/video/x8abcd1',
        });
    });

    it('maps direct file links to external media', async () => {
        const { service, preview } = build();
        const items = (await service.resolve([
            { type: 'embed', url: 'https://cdn.example.com/clip.MP4' },
            { type: 'embed', url: 'https://cdn.example.com/a.gif' },
            { type: 'embed', url: 'https://cdn.example.com/a.png?x=1' },
        ]))!;
        expect(items.map((item) => [item.type, item.external])).toEqual([
            ['video', true],
            ['gif', true],
            ['image', true],
        ]);
        expect(preview).not.toHaveBeenCalled();
    });

    it('resolves other links through the link preview as a link card', async () => {
        const { service, preview } = build();
        const [item] = (await service.resolve([
            { type: 'embed', url: 'https://example.com/page' },
        ]))!;
        expect(preview).toHaveBeenCalledWith('https://example.com/page');
        expect(item).toMatchObject({
            type: 'embed',
            embed: {
                provider: 'link',
                title: 'Example',
                description: 'Desc',
                thumbnail: 'https://example.com/og.png',
            },
        });
    });

    it('reports links the server cannot embed', async () => {
        const { service } = build(
            {},
            jest.fn().mockRejectedValue(new Error('blocked')),
        );
        await expect(
            service.resolve([{ type: 'embed', url: 'http://10.0.0.1/' }]),
        ).rejects.toMatchObject({
            response: { message: 'This link cannot be embedded!' },
        });
    });

    it('rejects non-http links and unknown input', async () => {
        const { service } = build();
        await expect(
            service.resolve([{ type: 'embed', url: 'javascript:alert(1)' }]),
        ).rejects.toMatchObject({
            response: { message: 'Media link must be a valid http(s) URL!' },
        });
        await expect(service.resolve('{oops')).rejects.toMatchObject({
            response: { message: 'Incorrect media!' },
        });
        await expect(service.resolve({ a: 1 })).rejects.toMatchObject({
            response: { message: 'Incorrect media!' },
        });
    });
});

describe('classifyEmbedUrl', () => {
    it('recognises short and shorts YouTube links', () => {
        expect(
            classifyEmbedUrl(new URL('https://youtu.be/dQw4w9WgXcQ')),
        ).toEqual({
            kind: 'embed',
            provider: 'youtube',
            id: 'dQw4w9WgXcQ',
        });
        expect(
            classifyEmbedUrl(new URL('https://youtube.com/shorts/dQw4w9WgXcQ')),
        ).toMatchObject({ kind: 'embed', provider: 'youtube' });
    });

    it('does not treat look-alike hosts as providers', () => {
        expect(
            classifyEmbedUrl(
                new URL('https://youtube.com.evil.io/watch?v=dQw4w9WgXcQ'),
            ),
        ).toEqual({ kind: 'link' });
    });
});

describe('legacy and presentation helpers', () => {
    it('exposes featured_image as media[0]', () => {
        expect(
            legacyMedia({
                featured_image: '/uploads/src/featured_image/1.png',
            }),
        ).toEqual([
            {
                id: 'legacy',
                type: 'image',
                url: '/uploads/src/featured_image/1.png',
            },
        ]);
        expect(legacyMedia({})).toEqual([]);
    });

    it('presentPost drops title/featured_image and adds media and excerpt', () => {
        const out = presentPost({
            _id: '1',
            title: 'Old title',
            featured_image: '/uploads/src/featured_image/1.png',
            content_text: '<p>Hello <b>world</b></p>',
        });
        expect(out).not.toHaveProperty('title');
        expect(out).not.toHaveProperty('featured_image');
        expect(out.excerpt).toBe('Hello world');
        expect(out.media).toHaveLength(1);
    });

    it('prefers real media over the legacy image', () => {
        const media = [
            {
                id: 'a',
                type: 'gif' as const,
                url: '/uploads/src/post_media/a.gif',
            },
        ];
        expect(
            presentPost({ media, featured_image: '/x.png', content_text: '' })
                .media,
        ).toEqual(media);
    });
});
