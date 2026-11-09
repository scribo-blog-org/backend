import { mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { Actor } from '../../authz/policy';
import type { FilesService } from '../../files/files.service';
import { postMediaLimitSize, postMediaTotalError } from '../../files/upload';
import type { LinkPreviewService } from '../link-preview/link-preview.service';
import { MEDIA_FILE_MISSING_ERROR, MediaService } from './media';
import { PostsService } from './posts.service';

const MB = 1024 * 1024;
const up = (name: string) => `/uploads/src/post_media/${name}`;
const actor = {
    id: 'u1',
    email: null,
    nick_name: 'nick',
    role: 'user',
    sessionId: null,
} as unknown as Actor;
const otherActor = { ...actor, id: 'someone-else' } as Actor;

let dir: string;

beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'scribo-posts-'));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

async function upload(fieldname: string, name = `${fieldname}.jpg`) {
    const file = path.join(dir, name);
    await writeFile(file, 'x');
    return {
        fieldname,
        path: file,
        filename: name,
        mimetype: 'image/jpeg',
        size: 1,
    } as Express.Multer.File;
}

function lean<T>(value: T) {
    return { lean: async () => value };
}

function build(options: { sizes?: Record<string, number>; stored?: any } = {}) {
    const removed: string[] = [];
    const order: string[] = [];
    const sizes = options.sizes ?? {};
    const files = {
        ownUploadPath: (url: unknown) =>
            typeof url === 'string' &&
            url.startsWith('/uploads/src/post_media/')
                ? url
                : null,
        uploadSize: async (url: string) => sizes[url] ?? null,
        finalizePostMedia: async (file: Express.Multer.File) => ({
            type: 'image',
            url: up(file.filename),
            mime: file.mimetype,
            size: sizes[up(file.filename)] ?? file.size,
        }),
        remove: async (url: string) => {
            removed.push(url);
            order.push(`remove:${url}`);
            return true;
        },
    } as unknown as FilesService;
    const previews = {
        fetchPreview: jest.fn(),
    } as unknown as LinkPreviewService;
    const media = new MediaService(files, previews);

    const stored = options.stored ?? null;
    const posts = {
        create: jest.fn(async (data: any) => ({
            _id: 'p1',
            ...data,
            toObject() {
                return { _id: 'p1', ...data };
            },
        })),
        findById: jest.fn(() => lean(stored)),
        findByIdAndUpdate: jest.fn((_id: string, update: any) => {
            order.push('db-update');
            return lean({ ...(stored ?? {}), ...update.$set, _id: 'p1' });
        }),
        findByIdAndDelete: jest.fn(() => lean(stored)),
        exists: jest.fn(async () => null),
    };
    const comments = {
        find: jest.fn(() => lean([])),
        deleteMany: jest.fn(),
    };
    const service = new PostsService(
        posts as any,
        comments as any,
        {} as any,
        {
            removePostFromSavedForUsers: jest.fn(),
            removeNotifications: jest.fn(),
        } as any,
        {} as any,
        {
            notifyFromText: jest.fn(),
            notifyNewMentions: jest.fn(),
        } as any,
        files,
        media,
        { action: jest.fn() } as any,
    );
    return { service, posts, removed, order };
}

describe('PostsService.create with uploads', () => {
    it('stores the mapped file, drops the unreferenced one, creates the post', async () => {
        const { service, posts } = build();
        const a = await upload('a');
        const stray = await upload('stray');
        await service.create(
            {
                postContent: '<p>hi</p>',
                media: JSON.stringify([{ upload: 'a' }]),
            },
            [a, stray],
            actor,
        );
        expect(posts.create).toHaveBeenCalledTimes(1);
        expect(posts.create.mock.calls[0][0].media).toMatchObject([
            { type: 'image', url: up('a.jpg'), size: 1 },
        ]);
        expect(existsSync(a.path)).toBe(true);
        expect(existsSync(stray.path)).toBe(false);
    });

    it('deletes every written file when the database write fails', async () => {
        const { service, posts } = build();
        posts.create.mockRejectedValueOnce(new Error('db down'));
        const a = await upload('a');
        const b = await upload('b');
        await expect(
            service.create(
                {
                    media: JSON.stringify([{ upload: 'a' }, { upload: 'b' }]),
                },
                [a, b],
                actor,
            ),
        ).rejects.toThrow('db down');
        expect(existsSync(a.path)).toBe(false);
        expect(existsSync(b.path)).toBe(false);
    });

    it('deletes the files when an upload item has no file part', async () => {
        const { service, posts } = build();
        const a = await upload('a');
        await expect(
            service.create(
                {
                    media: JSON.stringify([
                        { upload: 'a' },
                        { upload: 'ghost' },
                    ]),
                },
                [a],
                actor,
            ),
        ).rejects.toMatchObject({
            response: { message: MEDIA_FILE_MISSING_ERROR, field: 'media' },
        });
        expect(posts.create).not.toHaveBeenCalled();
        expect(existsSync(a.path)).toBe(false);
    });

    it('rejects and cleans up when the total size is over 100 MB', async () => {
        const { service, posts } = build({
            sizes: { [up('a.jpg')]: 60 * MB, [up('b.jpg')]: 50 * MB },
        });
        const a = await upload('a');
        const b = await upload('b');
        await expect(
            service.create(
                {
                    media: JSON.stringify([{ upload: 'a' }, { upload: 'b' }]),
                },
                [a, b],
                actor,
            ),
        ).rejects.toMatchObject({
            response: { message: postMediaTotalError() },
        });
        expect(posts.create).not.toHaveBeenCalled();
        expect(existsSync(a.path)).toBe(false);
        expect(existsSync(b.path)).toBe(false);
    });

    it('deletes files sent without any media field', async () => {
        const { service } = build();
        const a = await upload('a');
        await service.create({ postContent: '<p>text</p>' }, [a], actor);
        expect(existsSync(a.path)).toBe(false);
    });

    it('deletes the files when the post has no text and no media', async () => {
        const { service } = build();
        const a = await upload('a');
        await expect(
            service.create({ media: '[]' }, [a], actor),
        ).rejects.toBeDefined();
        expect(existsSync(a.path)).toBe(false);
    });
});

describe('PostsService.edit with uploads', () => {
    const stored = () => ({
        _id: 'p1',
        author: 'u1',
        content_text: '<p>old</p>',
        media: [
            { id: 'k1', type: 'image', url: up('keep.jpg'), size: 10 },
            { id: 'r1', type: 'image', url: up('removed.jpg'), size: 10 },
        ],
    });
    const sizes = {
        [up('keep.jpg')]: 10,
        [up('removed.jpg')]: 10,
    };

    it('adds a new file, keeps one, removes one only after the update', async () => {
        const { service, removed, order } = build({
            sizes,
            stored: stored(),
        });
        const added = await upload('n1');
        await service.edit(
            'p1',
            {
                media: JSON.stringify([
                    { id: 'k1', type: 'image', url: up('keep.jpg') },
                    { upload: 'n1' },
                ]),
            },
            [added],
            actor,
        );
        expect(removed).toEqual([up('removed.jpg')]);
        expect(order.indexOf('db-update')).toBeLessThan(
            order.indexOf(`remove:${up('removed.jpg')}`),
        );
        expect(existsSync(added.path)).toBe(true);
    });

    it('keeps old files and deletes the new ones when the update fails', async () => {
        const { service, posts, removed } = build({ sizes, stored: stored() });
        posts.findByIdAndUpdate.mockImplementationOnce(() => ({
            lean: async () => {
                throw new Error('db down');
            },
        }));
        const added = await upload('n1');
        await expect(
            service.edit(
                'p1',
                { media: JSON.stringify([{ upload: 'n1' }]) },
                [added],
                actor,
            ),
        ).rejects.toThrow('db down');
        expect(removed).toEqual([]);
        expect(existsSync(added.path)).toBe(false);
    });

    it('counts kept files and new files together against the 100 MB cap', async () => {
        const { service, posts } = build({
            sizes: {
                [up('keep.jpg')]: 70 * MB,
                [up('n1.jpg')]: postMediaLimitSize() - 60 * MB,
            },
            stored: stored(),
        });
        const added = await upload('n1');
        await expect(
            service.edit(
                'p1',
                {
                    media: JSON.stringify([
                        { id: 'k1', type: 'image', url: up('keep.jpg') },
                        { upload: 'n1' },
                    ]),
                },
                [added],
                actor,
            ),
        ).rejects.toMatchObject({
            response: { message: postMediaTotalError() },
        });
        expect(posts.findByIdAndUpdate).not.toHaveBeenCalled();
        expect(existsSync(added.path)).toBe(false);
    });

    it('deletes uploaded files when the actor may not edit the post', async () => {
        const { service } = build({ sizes, stored: stored() });
        const added = await upload('n1');
        await expect(
            service.edit(
                'p1',
                { media: JSON.stringify([{ upload: 'n1' }]) },
                [added],
                otherActor,
            ),
        ).rejects.toBeDefined();
        expect(existsSync(added.path)).toBe(false);
    });

    it('leaves media alone and drops stray files when media is omitted', async () => {
        const { service, removed } = build({ sizes, stored: stored() });
        const stray = await upload('stray');
        await service.edit('p1', { postContent: '<p>new</p>' }, [stray], actor);
        expect(removed).toEqual([]);
        expect(existsSync(stray.path)).toBe(false);
    });
});

describe('PostsService.remove', () => {
    it('deletes the post files but not links or files other posts still use', async () => {
        const { service, posts, removed } = build({
            stored: {
                _id: 'p1',
                author: 'u1',
                content_text: '<p>x</p>',
                media: [
                    { id: '1', type: 'image', url: up('own.jpg') },
                    { id: '2', type: 'image', url: up('shared.jpg') },
                    {
                        id: '3',
                        type: 'image',
                        url: 'https://img.example.com/a.png',
                        external: true,
                    },
                    {
                        id: '4',
                        type: 'embed',
                        url: 'https://youtu.be/xxxxxxxxxxx',
                    },
                ],
            },
        });
        posts.exists.mockImplementation((async (filter: any) =>
            JSON.stringify(filter).includes('shared.jpg')
                ? { _id: 'other' }
                : null) as any);
        await service.remove('6af09c0173cd73286e319ba2', actor);
        expect(removed).toEqual([up('own.jpg')]);
    });
});
