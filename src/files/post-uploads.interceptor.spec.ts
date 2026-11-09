import type { CallHandler, ExecutionContext } from '@nestjs/common';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { lastValueFrom, of, throwError } from 'rxjs';
import {
    PostUploadsCleanupInterceptor,
    PostUploadsGuardInterceptor,
    discardFiles,
    uploadedFiles,
} from './post-uploads.interceptor';
import {
    POST_MEDIA_BODY_OVERHEAD,
    postMediaLimitSize,
    postMediaTotalError,
} from './upload';

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'scribo-uploads-'));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

const context = (req: object) =>
    ({
        switchToHttp: () => ({ getRequest: () => req }),
    }) as unknown as ExecutionContext;

async function file(name: string) {
    const target = path.join(dir, name);
    await writeFile(target, 'x');
    return { path: target, fieldname: name } as Express.Multer.File;
}

describe('uploadedFiles / discardFiles', () => {
    it('reads array and field-map shapes and ignores missing files', async () => {
        const a = await file('a');
        const b = await file('b');
        expect(uploadedFiles({ files: [a, b] } as any)).toEqual([a, b]);
        expect(uploadedFiles({ files: { x: [a], y: [b] } } as any)).toEqual([
            a,
            b,
        ]);
        expect(uploadedFiles({} as any)).toEqual([]);

        await discardFiles([a, { path: path.join(dir, 'gone') }, b]);
        expect(existsSync(a.path)).toBe(false);
        expect(existsSync(b.path)).toBe(false);
        await expect(discardFiles(undefined)).resolves.toBeUndefined();
    });
});

describe('PostUploadsGuardInterceptor', () => {
    const next = { handle: () => of('ok') } as CallHandler;

    it('rejects a body that is clearly over the 100 MB budget', () => {
        const req = {
            headers: {
                'content-length': String(
                    postMediaLimitSize() + POST_MEDIA_BODY_OVERHEAD + 1,
                ),
            },
        };
        expect(() =>
            new PostUploadsGuardInterceptor().intercept(context(req), next),
        ).toThrow();
        try {
            new PostUploadsGuardInterceptor().intercept(context(req), next);
        } catch (error: any) {
            expect(error.getResponse()).toMatchObject({
                message: postMediaTotalError(),
                field: 'media',
            });
        }
    });

    it('lets normal and header-less requests through', async () => {
        const guard = new PostUploadsGuardInterceptor();
        const ok = await lastValueFrom(
            guard.intercept(
                context({ headers: { 'content-length': '1000' } }),
                next,
            ),
        );
        expect(ok).toBe('ok');
        const noHeader = await lastValueFrom(
            guard.intercept(context({ headers: {} }), next),
        );
        expect(noHeader).toBe('ok');
    });
});

describe('PostUploadsCleanupInterceptor', () => {
    it('deletes the uploaded files when the handler fails before the service owns them', async () => {
        const a = await file('a');
        const req = { files: [a] };
        const failing = {
            handle: () => throwError(() => new Error('validation')),
        } as CallHandler;
        await expect(
            lastValueFrom(
                new PostUploadsCleanupInterceptor().intercept(
                    context(req),
                    failing,
                ),
            ),
        ).rejects.toThrow('validation');
        expect(existsSync(a.path)).toBe(false);
    });

    it('leaves the files to the service once it owns them', async () => {
        const a = await file('a');
        const req = { files: [a], postUploadsOwned: true };
        const failing = {
            handle: () => throwError(() => new Error('after commit')),
        } as CallHandler;
        await expect(
            lastValueFrom(
                new PostUploadsCleanupInterceptor().intercept(
                    context(req),
                    failing,
                ),
            ),
        ).rejects.toThrow('after commit');
        expect(existsSync(a.path)).toBe(true);
    });

    it('does not touch files on success', async () => {
        const a = await file('a');
        const result = await lastValueFrom(
            new PostUploadsCleanupInterceptor().intercept(
                context({ files: [a] }),
                { handle: () => of('done') },
            ),
        );
        expect(result).toBe('done');
        expect(existsSync(a.path)).toBe(true);
    });
});
