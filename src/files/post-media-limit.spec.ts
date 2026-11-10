import express from 'express';
import type { AddressInfo } from 'net';
import { Server } from 'http';
import multer, { memoryStorage } from 'multer';
import {
    postMediaFileSizeError,
    postMediaLimitSize,
    postMediaMaxMb,
    postMediaTotalError,
} from './upload';

const MB = 1024 * 1024;

describe('POST_MEDIA_MAX_MB', () => {
    const original = process.env.POST_MEDIA_MAX_MB;

    afterEach(() => {
        if (original === undefined) delete process.env.POST_MEDIA_MAX_MB;
        else process.env.POST_MEDIA_MAX_MB = original;
    });

    it('defaults to 100 MB when unset', () => {
        delete process.env.POST_MEDIA_MAX_MB;
        expect(postMediaMaxMb()).toBe(100);
        expect(postMediaLimitSize()).toBe(100 * MB);
        expect(postMediaTotalError()).toBe(
            'Media in one post cannot exceed 100 MB',
        );
        expect(postMediaFileSizeError()).toBe(
            'Max size of the file should be 100 MB!',
        );
    });

    it('reads a valid value on every call', () => {
        process.env.POST_MEDIA_MAX_MB = '250';
        expect(postMediaMaxMb()).toBe(250);
        expect(postMediaLimitSize()).toBe(250 * MB);
        expect(postMediaTotalError()).toBe(
            'Media in one post cannot exceed 250 MB',
        );
        process.env.POST_MEDIA_MAX_MB = '20';
        expect(postMediaLimitSize()).toBe(20 * MB);
        expect(postMediaFileSizeError()).toBe(
            'Max size of the file should be 20 MB!',
        );
    });

    it('accepts fractional values', () => {
        process.env.POST_MEDIA_MAX_MB = '0.5';
        expect(postMediaLimitSize()).toBe(0.5 * MB);
    });

    it.each(['', 'abc', '0', '-5', 'NaN', 'Infinity'])(
        'falls back to 100 MB for %p',
        (value) => {
            process.env.POST_MEDIA_MAX_MB = value;
            expect(postMediaMaxMb()).toBe(100);
            expect(postMediaLimitSize()).toBe(100 * MB);
        },
    );
});

describe('lazy multer limit', () => {
    const original = process.env.POST_MEDIA_MAX_MB;
    let server: Server;
    let url: string;

    beforeAll(async () => {
        // Same shape as postMediaFilesInterceptor(): a limits object with a
        // getter, passed through the `{ ...options, ...localOptions }` spread
        // that Nest's interceptor mixin performs.
        const options = {
            limits: {
                get fileSize() {
                    return postMediaLimitSize();
                },
                files: 10,
            },
            storage: memoryStorage(),
        };
        const upload = multer({ ...options, ...{} });
        const app = express();
        app.post('/', upload.any(), (req, res) => {
            res.json({ files: (req.files as unknown[]).length });
        });
        app.use(
            (
                error: Error & { code?: string },
                _req: express.Request,
                res: express.Response,
                _next: express.NextFunction,
            ) => {
                res.status(400).json({ code: error.code });
            },
        );
        await new Promise<void>((resolve) => {
            server = app.listen(0, () => resolve());
        });
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    });

    afterAll(async () => {
        if (original === undefined) delete process.env.POST_MEDIA_MAX_MB;
        else process.env.POST_MEDIA_MAX_MB = original;
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    });

    const send = async (megabytes: number) => {
        const form = new FormData();
        form.append(
            'f',
            new Blob([new Uint8Array(Math.floor(megabytes * MB))]),
            'a.bin',
        );
        const response = await fetch(url, { method: 'POST', body: form });
        return { status: response.status, body: await response.json() };
    };

    it('applies the env value that is current for each request', async () => {
        process.env.POST_MEDIA_MAX_MB = '1';
        expect(await send(2)).toEqual({
            status: 400,
            body: { code: 'LIMIT_FILE_SIZE' },
        });

        process.env.POST_MEDIA_MAX_MB = '5';
        expect(await send(2)).toEqual({ status: 200, body: { files: 1 } });

        process.env.POST_MEDIA_MAX_MB = '1';
        expect((await send(2)).status).toBe(400);
    });
});
