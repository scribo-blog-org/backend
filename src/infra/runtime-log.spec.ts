import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { gzipSync } from 'zlib';
import { RuntimeLog, pruneDir, redact } from './runtime-log';
import {
    parseRuntimeLine,
    readRuntimeLogs,
} from '../modules/logs/runtime-logs.service';

const tmp = () => mkdtempSync(join(tmpdir(), 'scribo-log-'));
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('redact', () => {
    it('hides secret keys and serializes errors', () => {
        const out = redact({
            password: 'x',
            nested: { access_token: 'y', ok: 1 },
            err: new Error('boom'),
        }) as Record<string, any>;
        expect(out.password).toBe('[redacted]');
        expect(out.nested.access_token).toBe('[redacted]');
        expect(out.nested.ok).toBe(1);
        expect(out.err.message).toBe('boom');
    });
});

describe('RuntimeLog', () => {
    let stdout: jest.SpyInstance;
    let stderr: jest.SpyInstance;
    beforeEach(() => {
        stdout = jest.spyOn(process.stdout, 'write').mockReturnValue(true);
        stderr = jest.spyOn(process.stderr, 'write').mockReturnValue(true);
    });
    afterEach(() => {
        stdout.mockRestore();
        stderr.mockRestore();
    });

    it('writes JSON lines and respects the level', async () => {
        const dir = tmp();
        const log = new RuntimeLog({
            service: 'backend',
            version: '1.2.3',
            dir,
            level: 'warn',
        });
        log.info('skipped');
        log.error('kept', { code: 7 });
        await wait(50);
        log.close();
        const lines = readFileSync(join(dir, 'backend.log'), 'utf8')
            .trim()
            .split('\n');
        expect(lines).toHaveLength(1);
        expect(JSON.parse(lines[0])).toMatchObject({
            level: 'error',
            service: 'backend',
            version: '1.2.3',
            msg: 'kept',
            code: 7,
        });
        rmSync(dir, { recursive: true, force: true });
    });

    it('rotates by size and compresses the old file', async () => {
        const dir = tmp();
        const log = new RuntimeLog({
            service: 'backend',
            dir,
            fileBytes: 300,
            totalBytes: 10 * 1024 * 1024,
            retentionDays: 14,
        });
        for (let i = 0; i < 12; i += 1)
            log.info(`line ${i}`, { pad: 'x'.repeat(60) });
        await wait(300);
        log.close();
        const names = readdirSync(dir);
        expect(names.some((n) => /^backend-.*\.log\.gz$/.test(n))).toBe(true);
        expect(names).toContain('backend.log');
        rmSync(dir, { recursive: true, force: true });
    });

    it('keeps working on stdout when the directory is not writable', () => {
        const log = new RuntimeLog({
            service: 'backend',
            dir: join(tmpdir(), 'scribo-no\0such'),
        });
        expect(() => log.info('still fine')).not.toThrow();
        expect(() => log.error('still fine')).not.toThrow();
    });
});

describe('pruneDir', () => {
    it('removes expired files and trims to the total size', () => {
        const dir = tmp();
        const old = join(dir, 'backend-20200101-000000.log.gz');
        const mid = join(dir, 'backend-20260101-000000.log.gz');
        const fresh = join(dir, 'backend-20260102-000000.log.gz');
        for (const p of [old, mid, fresh]) writeFileSync(p, 'x'.repeat(100));
        const now = Date.now();
        utimesSync(
            old,
            new Date(now - 40 * 86400000),
            new Date(now - 40 * 86400000),
        );
        utimesSync(mid, new Date(now - 2000), new Date(now - 2000));
        utimesSync(fresh, new Date(now - 1000), new Date(now - 1000));
        pruneDir(
            dir,
            'backend',
            { retentionMs: 14 * 86400000, totalBytes: 150 },
            now,
        );
        expect(existsSync(old)).toBe(false);
        expect(existsSync(mid)).toBe(false);
        expect(existsSync(fresh)).toBe(true);
        rmSync(dir, { recursive: true, force: true });
    });
});

describe('runtime log reader', () => {
    it('parses app and request lines', () => {
        expect(
            parseRuntimeLine(
                '{"ts":"2026-11-10T10:00:00.000Z","level":"warn","service":"backend","msg":"m","a":1}',
                'backend',
            ),
        ).toMatchObject({ level: 'warn', msg: 'm', data: { a: 1 } });
        expect(
            parseRuntimeLine(
                '{"ts":"2026-11-10T10:00:00.000Z","level":"info","service":"backend","msg":"GET /api/posts","status":200,"total_ms":7,"request_id":"ab12"}',
                'backend',
            ),
        ).toMatchObject({
            level: 'info',
            msg: 'GET /api/posts',
            data: { status: 200, total_ms: 7, request_id: 'ab12' },
        });
        expect(parseRuntimeLine('garbage', 'backend')).toBeNull();
    });

    it('reads newest first across current and gzipped files with a cursor', () => {
        const root = tmp();
        const dir = join(root, 'backend');
        mkdirSync(dir);
        const row = (t: string, level: string, msg: string) =>
            JSON.stringify({ ts: t, level, service: 'backend', msg });
        writeFileSync(
            join(dir, 'backend-20260101-000000.log.gz'),
            gzipSync(
                [
                    row('2026-01-01T00:00:01.000Z', 'info', 'old-1'),
                    row('2026-01-01T00:00:02.000Z', 'error', 'old-2'),
                ].join('\n'),
            ),
        );
        writeFileSync(
            join(dir, 'backend.log'),
            [
                row('2026-01-02T00:00:01.000Z', 'info', 'new-1'),
                row('2026-01-02T00:00:02.000Z', 'warn', 'new-2'),
            ].join('\n'),
        );
        const first = readRuntimeLogs(root, { source: 'backend', limit: 3 });
        expect(first.items.map((i) => i.msg)).toEqual([
            'new-2',
            'new-1',
            'old-2',
        ]);
        expect(first.next).toBe('2026-01-01T00:00:02.000Z');
        const second = readRuntimeLogs(root, {
            source: 'backend',
            limit: 3,
            before: first.next as string,
        });
        expect(second.items.map((i) => i.msg)).toEqual(['old-1']);
        const errors = readRuntimeLogs(root, {
            source: 'backend',
            level: 'error',
        });
        expect(errors.items.map((i) => i.msg)).toEqual(['old-2']);
        const search = readRuntimeLogs(root, { source: 'backend', q: 'NEW-1' });
        expect(search.items.map((i) => i.msg)).toEqual(['new-1']);
        rmSync(root, { recursive: true, force: true });
    });

    it('merges several services newest first', () => {
        const root = tmp();
        for (const name of ['backend', 'frontend']) {
            mkdirSync(join(root, name));
        }
        const row = (service: string, t: string, msg: string) =>
            JSON.stringify({ ts: t, level: 'info', service, msg });
        writeFileSync(
            join(root, 'backend', 'backend.log'),
            [
                row('backend', '2026-01-02T00:00:01.000Z', 'b-1'),
                row('backend', '2026-01-02T00:00:03.000Z', 'b-3'),
            ].join('\n'),
        );
        writeFileSync(
            join(root, 'frontend', 'frontend.log'),
            row('frontend', '2026-01-02T00:00:02.000Z', 'f-2'),
        );
        const all = readRuntimeLogs(root, {
            sources: ['backend', 'frontend'],
            limit: 3,
        });
        expect(all.items.map((i) => i.msg)).toEqual(['b-3', 'f-2', 'b-1']);
        expect(all.items.map((i) => i.service)).toEqual([
            'backend',
            'frontend',
            'backend',
        ]);
        const page = readRuntimeLogs(root, {
            sources: ['backend', 'frontend'],
            limit: 2,
        });
        expect(page.items.map((i) => i.msg)).toEqual(['b-3', 'f-2']);
        expect(page.next).toBe('2026-01-02T00:00:02.000Z');
        rmSync(root, { recursive: true, force: true });
    });
});
