import { LoggerService } from './logger.service';
import { requestContextMiddleware, requestMeta } from './request-context';
import {
    categorySnapshot,
    changeOf,
    compact,
    textPreview,
} from './log-helpers';

function setup() {
    const created: Array<Record<string, any>> = [];
    const model = {
        create: jest.fn((doc: Record<string, any>) => {
            created.push(doc);
            return Promise.resolve(doc);
        }),
    };
    return { logger: new LoggerService(model as never), created, model };
}

describe('LoggerService', () => {
    afterEach(() => jest.restoreAllMocks());

    it('action puts the author and a snapshot of the nick into the record', async () => {
        const { logger, created } = setup();
        await logger.action(
            'like_post',
            { id: 'u1', nick_name: 'anna', avatar: 'a.png' },
            { post: 'p1', post_title: 'Hello' },
        );
        expect(created[0]).toMatchObject({
            type: 'like_post',
            data: {
                user: 'u1',
                user_nick: 'anna',
                user_avatar: 'a.png',
                post: 'p1',
                post_title: 'Hello',
            },
        });
    });

    it('system events are marked as such and have no author', async () => {
        const { logger, created } = setup();
        await logger.system('server_start', 'Server started', { port: 3001 });
        expect(created[0].data).toEqual({ system: true, port: 3001 });
        expect(created[0].data.user).toBeUndefined();
    });

    it('does not throw when the database write fails', async () => {
        const { logger, model } = setup();
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        model.create.mockRejectedValueOnce(new Error('down'));
        await expect(logger.system('x', 'y')).resolves.toBeUndefined();
    });

    describe('error', () => {
        const err = (path = '/api/posts', message = 'boom') => ({
            status: 500,
            method: 'GET',
            path,
            message,
            stack: Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'),
        });

        it('stores the status, the route and a short stack', async () => {
            const { logger, created } = setup();
            await logger.error(err());
            expect(created[0].type).toBe('server_error');
            expect(created[0].data).toMatchObject({
                system: true,
                status: 500,
                method: 'GET',
                path: '/api/posts',
                error: 'boom',
            });
            expect(created[0].data.stack.split('\n')).toHaveLength(30);
        });

        it('writes the same error only once a minute', async () => {
            const { logger, created } = setup();
            await logger.error(err());
            await logger.error(err());
            await logger.error(err('/api/other'));
            expect(created).toHaveLength(2);
        });

        it('caps the number of different errors per minute', async () => {
            const { logger, created } = setup();
            for (let i = 0; i < 100; i++) await logger.error(err(`/p${i}`));
            expect(created).toHaveLength(30);
        });
    });
});

describe('log helpers', () => {
    it('textPreview flattens and shortens text', () => {
        expect(textPreview('  a \n\n b  ')).toBe('a b');
        expect(textPreview('x'.repeat(300), 10)).toBe(`${'x'.repeat(10)}…`);
        expect(textPreview('   ')).toBeNull();
        expect(textPreview(5)).toBeNull();
    });

    it('changeOf reports only real changes', () => {
        expect(changeOf('name', 'test', 'test1')).toEqual({
            field: 'name',
            from: 'test',
            to: 'test1',
        });
        expect(changeOf('name', 'same', 'same')).toBeNull();
        expect(changeOf('color', 3, 3)).toBeNull();
        expect(changeOf('is_email_public', false, true)).toEqual({
            field: 'is_email_public',
            from: false,
            to: true,
        });
    });

    it('categorySnapshot keeps what is needed to draw the chip later', () => {
        expect(
            categorySnapshot({
                name: 'News',
                icon: 4,
                color: 2,
                extra: 1,
            } as never),
        ).toEqual({ name: 'News', icon: 4, color: 2 });
        expect(categorySnapshot(null)).toBeNull();
    });

    it('compact drops empty entries', () => {
        expect(compact([null, { field: 'a' }, undefined])).toEqual([
            { field: 'a' },
        ]);
    });
});

describe('request context in the log', () => {
    const req = (extra: Record<string, unknown> = {}) =>
        ({
            method: 'POST',
            originalUrl: '/api/posts/1/like?token=secret',
            ip: '203.0.113.7',
            headers: { 'user-agent': 'x'.repeat(300) },
            ...extra,
        }) as never;

    it('keeps the route without the query string and cuts a long user agent', () => {
        const meta = requestMeta(req());
        expect(meta.path).toBe('/api/posts/1/like');
        expect(meta.user_agent).toHaveLength(200);
        expect(meta.ip).toBe('203.0.113.7');
        expect(meta.id).toMatch(/^[a-f0-9]{12}$/);
    });

    it('attaches the request that caused the record, and only inside a request', async () => {
        const created: Array<Record<string, any>> = [];
        const logger = new LoggerService({
            create: (doc: Record<string, any>) => {
                created.push(doc);
                return Promise.resolve(doc);
            },
        } as never);

        await logger.system('outside', 'no request here');
        await new Promise<void>((resolve) =>
            requestContextMiddleware(req(), { setHeader() {} } as never, () => {
                void logger
                    .action(
                        'like_post',
                        { id: 'u1', nick_name: 'a', role: 'author' },
                        { post: 'p' },
                    )
                    .then(() => resolve());
            }),
        );

        expect(created[0].data.request).toBeUndefined();
        expect(created[1].data.request).toMatchObject({
            method: 'POST',
            path: '/api/posts/1/like',
        });
        expect(created[1].data).toMatchObject({
            user_role: 'author',
            post: 'p',
        });
    });
});

describe('LoggerService diagnostics', () => {
    const base = { type: 'login_failed', message: 'Failed sign-in', key: 'k' };

    it('writes one row per key per window and counts the skipped repeats', async () => {
        const { logger, created } = setup();
        const now = jest.spyOn(Date, 'now').mockReturnValue(1_000_000);
        await logger.diagnostic(base);
        await logger.diagnostic(base);
        await logger.diagnostic(base);
        expect(created).toHaveLength(1);
        expect(created[0].level).toBe('warn');

        now.mockReturnValue(1_000_000 + 31_000);
        await logger.diagnostic(base);
        expect(created).toHaveLength(2);
        expect(created[1].data.repeats).toBe(2);
    });

    it('keeps different keys apart', async () => {
        const { logger, created } = setup();
        await logger.diagnostic(base);
        await logger.diagnostic({ ...base, key: 'other' });
        expect(created).toHaveLength(2);
    });

    it('ignores requests faster than the threshold and unmatched routes', async () => {
        const { logger, created } = setup();
        const sample = {
            route: 'GET /api/posts',
            status: 200,
            total_ms: 1500,
            db_ms: 900,
            db_queries: 42,
            user: 'u1',
            method: 'GET',
            path: '/api/posts',
            request_id: 'r1',
        };
        await logger.slowRequest({ ...sample, total_ms: 200 });
        await logger.slowRequest({ ...sample, route: 'GET (no route)' });
        await logger.slowRequest({ ...sample, route: 'POST /api/backups/run' });
        expect(created).toHaveLength(0);

        await logger.slowRequest(sample);
        expect(created[0]).toMatchObject({
            type: 'slow_request',
            data: { db_queries: 42, db_ms: 900, total_ms: 1500, user: 'u1' },
        });
    });
});
