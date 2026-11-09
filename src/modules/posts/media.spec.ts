import type { FilesService } from '../../files/files.service';
import { POST_MEDIA_LIMIT_SIZE } from '../../files/upload';
import type { LinkPreviewService } from '../link-preview/link-preview.service';
import {
    MEDIA_FILE_MISSING_ERROR,
    MEDIA_LINK_UNSUPPORTED_ERROR,
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
        finalizePostMedia: async (file: Express.Multer.File) => ({
            type: file.mimetype === 'image/gif' ? 'gif' : 'image',
            url: up(file.filename),
            mime: file.mimetype,
            size: sizes[up(file.filename)] ?? file.size,
        }),
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

    it('rejects ordinary page links instead of making a link card', async () => {
        const { service, preview } = build();
        await expect(
            service.resolve([
                { type: 'embed', url: 'https://example.com/page' },
            ]),
        ).rejects.toMatchObject({
            response: { message: MEDIA_LINK_UNSUPPORTED_ERROR },
        });
        expect(preview).toHaveBeenCalledWith('https://example.com/page');
    });

    it('turns Twitch videos, clips and channels into players', async () => {
        const { service, preview } = build(
            {},
            jest.fn().mockResolvedValue({
                url: 'x',
                title: 't',
                description: '',
                image: 'https://static-cdn.jtvnw.net/thumb.jpg',
                site_name: 'twitch.tv',
            }),
        );
        const items = (await service.resolve([
            { type: 'embed', url: 'https://www.twitch.tv/videos/123456789' },
            {
                type: 'embed',
                url: 'https://www.twitch.tv/fleem_ff/clip/Slug-Name_1',
            },
            { type: 'embed', url: 'https://clips.twitch.tv/Slug-Name_2' },
            { type: 'embed', url: 'https://m.twitch.tv/Fleem_FF' },
        ]))!;
        expect(items.map((item) => [item.url, item.embed?.embed_url])).toEqual([
            [
                'https://www.twitch.tv/videos/123456789',
                'https://player.twitch.tv/?video=v123456789',
            ],
            [
                'https://clips.twitch.tv/Slug-Name_1',
                'https://clips.twitch.tv/embed?clip=Slug-Name_1',
            ],
            [
                'https://clips.twitch.tv/Slug-Name_2',
                'https://clips.twitch.tv/embed?clip=Slug-Name_2',
            ],
            [
                'https://www.twitch.tv/fleem_ff',
                'https://player.twitch.tv/?channel=fleem_ff',
            ],
        ]);
        expect(items.every((item) => item.embed?.provider === 'twitch')).toBe(
            true,
        );
        expect(items[0].embed?.thumbnail).toBe(
            'https://static-cdn.jtvnw.net/thumb.jpg',
        );
        expect(preview).toHaveBeenCalledTimes(4);
    });

    it('still saves a Twitch player when the thumbnail lookup fails', async () => {
        const { service } = build(
            {},
            jest.fn().mockRejectedValue(new Error('down')),
        );
        const [item] = (await service.resolve([
            { type: 'embed', url: 'https://www.twitch.tv/fleem_ff' },
        ]))!;
        expect(item.embed).toEqual({
            provider: 'twitch',
            embed_url: 'https://player.twitch.tv/?channel=fleem_ff',
        });
    });

    it('does not treat reserved Twitch paths as channels', async () => {
        const { service } = build();
        await expect(
            service.resolve([
                { type: 'embed', url: 'https://www.twitch.tv/directory' },
            ]),
        ).rejects.toMatchObject({
            response: { message: MEDIA_LINK_UNSUPPORTED_ERROR },
        });
    });

    it('keeps a legacy link card that is already stored on the post', async () => {
        const { service } = build();
        const legacy = {
            id: 'old',
            type: 'embed' as const,
            url: 'https://example.com/page',
            embed: {
                provider: 'link' as const,
                embed_url: 'https://example.com/page',
                title: 'Example',
            },
        };
        const items = (await service.resolve([legacy], [], [legacy]))!;
        expect(items).toEqual([legacy]);
        await expect(service.resolve([legacy])).rejects.toMatchObject({
            response: { message: MEDIA_LINK_UNSUPPORTED_ERROR },
        });
    });
    it('maps extensionless links that serve an image to external media', async () => {
        const { service, preview } = build();
        preview.mockResolvedValueOnce({
            url: 'https://img.example.com/images?id=1',
            title: 'img.example.com',
            description: '',
            image: 'https://img.example.com/images?id=1',
            site_name: 'img.example.com',
            media_type: 'image',
        });
        const [item] = (await service.resolve([
            { type: 'embed', url: 'https://img.example.com/images?id=1' },
        ]))!;
        expect(item).toMatchObject({
            type: 'image',
            url: 'https://img.example.com/images?id=1',
            external: true,
        });
    });

    it('rejects links the server cannot fetch', async () => {
        const { service } = build(
            {},
            jest.fn().mockRejectedValue(new Error('blocked')),
        );
        await expect(
            service.resolve([{ type: 'embed', url: 'http://10.0.0.1/' }]),
        ).rejects.toMatchObject({
            response: { message: MEDIA_LINK_UNSUPPORTED_ERROR },
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

describe('MediaService.resolveWithFiles', () => {
    const part = (
        fieldname: string,
        extra: Partial<Express.Multer.File> = {},
    ) =>
        ({
            fieldname,
            filename: `${fieldname}.jpg`,
            mimetype: 'image/jpeg',
            size: 100,
            path: `/tmp/${fieldname}.jpg`,
            ...extra,
        }) as Express.Multer.File;

    it('maps upload items to the file part with the same client id', async () => {
        const { service } = build();
        const result = await service.resolveWithFiles(
            JSON.stringify([
                { upload: 'second' },
                { upload: 'first', width: 10, height: 20 },
            ]),
            [part('first'), part('second', { mimetype: 'image/gif' })],
        );
        expect(
            result?.items.map((item) => [item.type, item.url, item.width]),
        ).toEqual([
            ['gif', up('second.jpg'), undefined],
            ['image', up('first.jpg'), 10],
        ]);
        expect(result?.unused).toEqual([]);
    });

    it('reports file parts nobody referenced as unused', async () => {
        const { service } = build();
        const stray = part('stray');
        const result = await service.resolveWithFiles(
            JSON.stringify([{ upload: 'a' }]),
            [part('a'), stray],
        );
        expect(result?.unused).toEqual([stray]);
    });

    it('fails with a clear error when the file part is missing', async () => {
        const { service } = build();
        await expect(
            service.resolveWithFiles(JSON.stringify([{ upload: 'ghost' }]), []),
        ).rejects.toMatchObject({
            response: { message: MEDIA_FILE_MISSING_ERROR, field: 'media' },
        });
    });

    it('rejects referencing the same file part twice and bad client ids', async () => {
        const { service } = build();
        await expect(
            service.resolveWithFiles(
                JSON.stringify([{ upload: 'a' }, { upload: 'a' }]),
                [part('a')],
            ),
        ).rejects.toMatchObject({ response: { message: 'Incorrect media!' } });
        await expect(
            service.resolveWithFiles(JSON.stringify([{ upload: '../x' }]), [
                part('../x'),
            ]),
        ).rejects.toMatchObject({ response: { message: 'Incorrect media!' } });
    });

    it('sums new and kept files together against 100 MB', async () => {
        const { service } = build({
            [up('keep.jpg')]: 70 * MB,
            [up('new.jpg')]: 40 * MB,
        });
        await expect(
            service.resolveWithFiles(
                JSON.stringify([
                    { type: 'image', url: up('keep.jpg') },
                    { upload: 'new' },
                ]),
                [part('new')],
            ),
        ).rejects.toMatchObject({ response: { message: MEDIA_TOTAL_ERROR } });
    });

    it('mixes kept files, new uploads and embeds', async () => {
        const { service } = build({ [up('keep.jpg')]: 5 });
        const result = await service.resolveWithFiles(
            JSON.stringify([
                { id: 'k', type: 'image', url: up('keep.jpg') },
                { upload: 'n' },
                { type: 'embed', url: 'https://youtu.be/dQw4w9WgXcQ' },
            ]),
            [part('n')],
        );
        expect(result?.items.map((item) => item.type)).toEqual([
            'image',
            'image',
            'embed',
        ]);
        expect(result?.items[0].id).toBe('k');
    });

    it('treats every file as unused when media is cleared', async () => {
        const { service } = build();
        const stray = part('a');
        const result = await service.resolveWithFiles('[]', [stray]);
        expect(result).toEqual({ items: [], unused: [stray] });
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

    it('classifies Twitch videos, clips and channels', () => {
        expect(
            classifyEmbedUrl(new URL('https://www.twitch.tv/videos/123456')),
        ).toEqual({ kind: 'embed', provider: 'twitch', id: 'video:123456' });
        expect(
            classifyEmbedUrl(new URL('https://twitch.tv/a_b_c/clip/SlugX')),
        ).toEqual({ kind: 'embed', provider: 'twitch', id: 'clip:SlugX' });
        expect(
            classifyEmbedUrl(new URL('https://clips.twitch.tv/SlugX')),
        ).toEqual({ kind: 'embed', provider: 'twitch', id: 'clip:SlugX' });
        expect(
            classifyEmbedUrl(new URL('https://m.twitch.tv/Some_Name')),
        ).toEqual({
            kind: 'embed',
            provider: 'twitch',
            id: 'channel:some_name',
        });
    });

    it('leaves reserved or foreign Twitch paths as plain links', () => {
        for (const link of [
            'https://www.twitch.tv/directory',
            'https://www.twitch.tv/settings',
            'https://www.twitch.tv/videos/abc',
            'https://www.twitch.tv/a/b/c/d',
            'https://nottwitch.tv/some_name',
            'https://twitch.tv.evil.io/some_name',
            'https://clips.twitch.tv/embed',
        ]) {
            expect(classifyEmbedUrl(new URL(link))).toEqual({ kind: 'link' });
        }
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
