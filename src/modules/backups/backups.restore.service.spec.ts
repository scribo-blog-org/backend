import { ConfigService } from '@nestjs/config';
import { execFileSync } from 'child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { BackupRestoreService } from './backups.restore.service';
import { BackupsService } from './backups.service';
import { readState, writeLock } from './backups.state';
import { fakeConnection, fakeModel } from './backups.test-utils';
import { MaintenanceGuard } from './maintenance.guard';

describe('backup restore', () => {
    let root: string;
    let dir: string;
    let uploads: string;
    let bin: string;
    let calls: string;
    let connection: ReturnType<typeof fakeConnection>;
    let model: ReturnType<typeof fakeModel>;
    let backups: BackupsService;
    let restore: BackupRestoreService;

    const build = (extra: Record<string, string> = {}) => {
        backups = new BackupsService(
            new ConfigService({
                BACKUP_ENABLED: 'true',
                BACKUP_RESTORE_ENABLED: 'true',
                BACKUPS_DIR: dir,
                UPLOADS_DIR: uploads,
                MONGODUMP_BIN: path.join(bin, 'mongodump'),
                MONGORESTORE_BIN: path.join(bin, 'mongorestore'),
                MONGODB_URI: "mongodb+srv://u:p'w@host/scribo?retryWrites=true",
                BACKUP_KEEP_PRE_RESTORE: '1',
                ...extra,
            }),
            model as any,
            connection as any,
        );
        restore = new BackupRestoreService(backups, connection as any);
    };

    const script = (name: string, body: string) => {
        const file = path.join(bin, name);
        writeFileSync(file, `#!/bin/sh\n${body}\n`);
        chmodSync(file, 0o755);
    };

    const idle = async () => {
        for (let i = 0; i < 300; i++) {
            if (!backups.status().running && !backups.status().restoring) {
                return;
            }
            await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error('did not finish');
    };

    const makeBackup = async () => {
        await backups.start('manual', '64b64c1f1c9a4f0e5a1b2c3d');
        await idle();
        return model.docs.filter((d) => d.kind === 'daily').at(-1)!;
    };

    const files = (base: string): string[] =>
        readdirSync(base, { recursive: true, withFileTypes: true })
            .filter((e) => e.isFile())
            .map((e) => path.relative(base, path.join(e.parentPath, e.name)))
            .sort();

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), 'scribo-restore-'));
        dir = path.join(root, 'backups');
        uploads = path.join(root, 'uploads');
        bin = path.join(root, 'bin');
        calls = path.join(root, 'restore-calls');
        mkdirSync(path.join(uploads, 'src/avatar'), { recursive: true });
        mkdirSync(bin);
        writeFileSync(path.join(uploads, 'src/avatar/a.png'), 'AAA');
        script('mongodump', 'printf "dump-bytes"');
        // Каждый вызов дописывает свои аргументы в файл. Если рядом лежит
        // fail-on-N, вызов с этим номером падает.
        script(
            'mongorestore',
            `echo "$@" >> "${calls}"; n=$(wc -l < "${calls}" | tr -d ' ');
if [ -f "${root}/fail-on-$n" ]; then echo "boom mongodb+srv://u:secret@h/db" >&2; exit 4; fi`,
        );
        mkdirSync(dir);
        model = fakeModel();
        connection = fakeConnection(['users', 'posts', 'backups']);
        build();
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const callCount = () =>
        existsSync(calls)
            ? readFileSync(calls, 'utf8').split('\n').filter(Boolean).length
            : 0;

    it('writes a manifest that binds the dump and the uploads', async () => {
        const record = await makeBackup();
        const archive = path.join(dir, record.file_name);
        const raw = execFileSync('tar', ['-xOf', archive, 'manifest.json']);
        const manifest = JSON.parse(raw.toString());

        expect(manifest.id).toBe(record._id);
        expect(manifest.db.name).toBe('scribo');
        expect(manifest.db.collections).toEqual(['backups', 'posts', 'users']);
        expect(manifest.db.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(manifest.uploads).toEqual({
            dir: 'uploads',
            files: 1,
            bytes: 3,
        });
        expect(manifest.based_on).toBeNull();
        expect(record.contents).toMatchObject({
            db_name: 'scribo',
            uploads_files: 1,
        });
    });

    it('restores the uploads, passes the right flags and records the current backup', async () => {
        const record = await makeBackup();
        // Состояние после бекапа: файл удалён, появился чужой, в базе новая коллекция.
        rmSync(path.join(uploads, 'src/avatar/a.png'));
        writeFileSync(path.join(uploads, 'src/avatar/b.png'), 'BBB');
        connection.names.push('created_later');

        await restore.start(record._id, '64b64c1f1c9a4f0e5a1b2c3d');
        await idle();

        expect(restore['job']).toMatchObject({ status: 'success' });
        expect(files(uploads)).toEqual(['src/avatar/a.png']);
        expect(
            readFileSync(path.join(uploads, 'src/avatar/a.png'), 'utf8'),
        ).toBe('AAA');

        const args = readFileSync(calls, 'utf8');
        expect(args).toContain('--drop');
        expect(args).toContain('--nsInclude=scribo.*');
        expect(args).toContain('--nsExclude=scribo.backups');
        expect(args).toContain('mongo.archive.gz');
        expect(args).not.toContain("p'w");
        // Коллекция, созданная после бекапа, убрана; история бекапов осталась.
        expect(connection.names.sort()).toEqual(['backups', 'posts', 'users']);

        const state = await readState(dir);
        expect(state.current).toMatchObject({
            backup_id: record._id,
            file_name: record.file_name,
        });
        expect(state.last_restore).toMatchObject({
            status: 'success',
            rolled_back: false,
        });
        expect(existsSync(path.join(dir, 'restore.lock'))).toBe(false);
        expect(readdirSync(dir).filter((n) => n.startsWith('.'))).toEqual([]);

        // Страховочный снимок создан и отличается от обычного бекапа.
        const snapshot = model.docs.find((d) => d.kind === 'pre_restore')!;
        expect(snapshot.status).toBe('success');
        expect(snapshot.file_name).toMatch(/^scribo-pre-restore-/);
        expect(state.last_restore!.safety_backup_id).toBe(snapshot._id);
    });

    it('stores the backup it is based on in the next manifest', async () => {
        const first = await makeBackup();
        await restore.start(first._id, null);
        await idle();
        writeFileSync(path.join(uploads, 'x'), 'x');
        const second = await makeBackup();
        expect(second.contents.based_on).toBe(first._id);
    });

    it('refuses a damaged archive before touching anything', async () => {
        const record = await makeBackup();
        const archive = path.join(dir, record.file_name);
        // Подменяем дамп внутри архива на тот же размер, но другие байты.
        const tmp = path.join(root, 'tamper');
        mkdirSync(tmp);
        execFileSync('tar', ['-xf', archive, '-C', tmp]);
        writeFileSync(path.join(tmp, 'mongo.archive.gz'), 'XXXX-bytes');
        execFileSync('tar', ['-cf', archive, '-C', tmp, '.']);
        writeFileSync(path.join(uploads, 'src/avatar/keep.png'), 'KEEP');

        await restore.start(record._id, null);
        await idle();

        expect(restore['job']).toMatchObject({ status: 'failed' });
        expect(restore['job']!.error).toMatch(/checksum|wrong size/);
        expect(callCount()).toBe(0);
        expect(existsSync(path.join(uploads, 'src/avatar/keep.png'))).toBe(
            true,
        );
        expect(model.docs.some((d) => d.kind === 'pre_restore')).toBe(false);
        expect((await readState(dir)).current).toBeNull();
    });

    it('rolls back to the safety snapshot when mongorestore fails', async () => {
        const record = await makeBackup();
        rmSync(path.join(uploads, 'src/avatar/a.png'));
        writeFileSync(path.join(uploads, 'src/avatar/b.png'), 'BBB');
        writeFileSync(path.join(root, 'fail-on-1'), '');

        await restore.start(record._id, null);
        await idle();

        const job = restore['job']!;
        expect(job.status).toBe('failed');
        expect(job.rolled_back).toBe(true);
        expect(job.error).toContain('boom mongodb+srv://***@');
        expect(job.error).not.toContain('secret');
        // Второй вызов mongorestore это возврат к снимку, файлы как до отката.
        expect(callCount()).toBe(2);
        expect(files(uploads)).toEqual(['src/avatar/b.png']);
        const state = await readState(dir);
        expect(state.current).toBeNull();
        expect(state.last_restore).toMatchObject({
            status: 'failed',
            rolled_back: true,
        });
    });

    it('says so when the rollback fails too', async () => {
        const record = await makeBackup();
        writeFileSync(path.join(root, 'fail-on-1'), '');
        writeFileSync(path.join(root, 'fail-on-2'), '');

        await restore.start(record._id, null);
        await idle();

        expect(restore['job']!.rolled_back).toBe(false);
        expect(restore['job']!.error).toMatch(/rollback failed.*manually/);
    });

    it('keeps only the configured number of safety snapshots', async () => {
        const record = await makeBackup();
        await restore.start(record._id, null);
        await idle();
        await restore.start(record._id, null);
        await idle();
        // Каждый бекап/откат прунит после себя: запускаем ещё один бекап.
        await makeBackup();

        const snapshots = model.docs.filter((d) => d.kind === 'pre_restore');
        expect(snapshots).toHaveLength(2);
        expect(snapshots.filter((s) => !s.file_removed_at)).toHaveLength(1);
        const left = readdirSync(dir).filter((n) =>
            n.startsWith('scribo-pre-restore-'),
        );
        expect(left).toHaveLength(1);
    });

    it('is off unless explicitly enabled, and only for archives with a manifest', async () => {
        const record = await makeBackup();
        build({ BACKUP_RESTORE_ENABLED: 'false' });
        await expect(restore.start(record._id, null)).rejects.toThrow(
            'disabled',
        );

        build();
        record.contents = null;
        await expect(restore.start(record._id, null)).rejects.toThrow(
            'no manifest',
        );
    });

    it('refuses a backup of another database', async () => {
        const record = await makeBackup();
        record.contents.db_name = 'other';
        await expect(restore.start(record._id, null)).rejects.toThrow(
            '"other"',
        );
    });

    it('does not run next to a backup or a second restore', async () => {
        const record = await makeBackup();
        script('mongodump', 'sleep 1; printf x');
        await backups.start('manual');
        await expect(restore.start(record._id, null)).rejects.toThrow(
            'already running',
        );
        await idle();
        // Новый бекап за тот же день заменил прежнюю запись: берём свежую.
        const latest = model.docs.filter((d) => d.kind === 'daily').at(-1)!;
        await restore.start(latest._id, null);
        await expect(backups.start('manual')).rejects.toThrow(
            'restore is in progress',
        );
        await idle();
    });

    it('marks a restore that was interrupted by a crash', async () => {
        await writeLock(dir, {
            backup_id: 'abc',
            file_name: 'scribo-2026-10-02.tar',
            started_at: new Date().toISOString(),
            restored_by: null,
            safety_backup_id: 'snap1',
        });
        await restore.onModuleInit();

        const state = await readState(dir);
        expect(state.last_restore).toMatchObject({
            status: 'interrupted',
            safety_backup_id: 'snap1',
        });
        expect(existsSync(path.join(dir, 'restore.lock'))).toBe(false);
    });

    describe('MaintenanceGuard', () => {
        const ctx = (method: string, url: string) =>
            ({
                switchToHttp: () => ({
                    getRequest: () => ({ method, originalUrl: url }),
                }),
            }) as any;

        it('lets everything through when no restore is running', () => {
            const guard = new MaintenanceGuard(backups);
            expect(guard.canActivate(ctx('POST', '/api/posts'))).toBe(true);
        });

        it('blocks writes, but not reads or the backups API, during a restore', () => {
            backups.acquire('restore');
            const guard = new MaintenanceGuard(backups);
            expect(guard.canActivate(ctx('GET', '/api/posts'))).toBe(true);
            expect(
                guard.canActivate(ctx('POST', '/api/backups/1/restore')),
            ).toBe(true);
            expect(() => guard.canActivate(ctx('POST', '/api/posts'))).toThrow(
                'being restored',
            );
            expect(() =>
                guard.canActivate(ctx('DELETE', '/api/comments/1')),
            ).toThrow();
        });
    });
});
