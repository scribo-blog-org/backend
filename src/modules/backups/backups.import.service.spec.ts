import { ConfigService } from '@nestjs/config';
import { execFileSync } from 'child_process';
import { createHash } from 'crypto';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { gzipSync } from 'zlib';
import { BackupImportService } from './backups.import.service';
import { BackupRestoreService } from './backups.restore.service';
import { BackupsService } from './backups.service';
import { dbVersionOf } from './db-version';
import { appVersion } from './manifest';
import { fakeConnection, fakeLogger, fakeModel } from './backups.test-utils';

const APP = appVersion();
const MONGODUMP_MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81]);
const goodDump = () =>
    gzipSync(Buffer.concat([MONGODUMP_MAGIC, Buffer.from('rest')]));

function rawHeader(name: string, size: number, type: string, link = '') {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write('0000644\0', 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124);
    header.write('00000000000\0', 136);
    header.write('        ', 148);
    header.write(type, 156);
    header.write(link, 157, 100);
    header.write('ustar\0', 257);
    header.write('00', 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    return header;
}

function rawTar(
    entries: { name: string; data?: string; type?: string; link?: string }[],
) {
    const blocks: Buffer[] = [];
    for (const entry of entries) {
        const data = Buffer.from(entry.data ?? '');
        blocks.push(
            rawHeader(entry.name, data.length, entry.type ?? '0', entry.link),
        );
        if (data.length) {
            blocks.push(data, Buffer.alloc((512 - (data.length % 512)) % 512));
        }
    }
    blocks.push(Buffer.alloc(1024));
    return Buffer.concat(blocks);
}

describe('backup upload', () => {
    let root: string;
    let dir: string;
    let uploads: string;
    let bin: string;
    let calls: string;
    let model: ReturnType<typeof fakeModel>;
    let logger: ReturnType<typeof fakeLogger>;
    let backups: BackupsService;
    let imports: BackupImportService;
    let restore: BackupRestoreService;
    let counter = 0;

    const build = (extra: Record<string, string> = {}) => {
        const connection = fakeConnection(['users', 'posts', 'backups']);
        backups = new BackupsService(
            new ConfigService({
                BACKUP_ENABLED: 'true',
                BACKUP_RESTORE_ENABLED: 'true',
                BACKUPS_DIR: dir,
                UPLOADS_DIR: uploads,
                MONGODUMP_BIN: path.join(bin, 'mongodump'),
                MONGORESTORE_BIN: path.join(bin, 'mongorestore'),
                MONGODB_URI: 'mongodb://h/scribo',
                BACKUP_KEEP_UPLOADED: '1',
                ...extra,
            }),
            model as any,
            connection as any,
            logger as any,
        );
        imports = new BackupImportService(backups);
        restore = new BackupRestoreService(
            backups,
            connection as any,
            logger as any,
        );
    };

    const makeArchive = (
        options: {
            id?: string;
            dbName?: string;
            appVersion?: string;
            dbVersion?: string | null;
            dump?: Buffer;
            sha?: string;
            files?: Record<string, string>;
            link?: boolean;
        } = {},
    ) => {
        const base = path.join(root, `src-${counter++}`);
        const work = path.join(base, 'work');
        const up = path.join(base, 'uploads');
        mkdirSync(work, { recursive: true });
        mkdirSync(path.join(up, 'src'), { recursive: true });
        const files = options.files ?? { 'src/a.png': 'img' };
        for (const [name, data] of Object.entries(files)) {
            writeFileSync(path.join(up, name), data);
        }
        if (options.link) symlinkSync('/etc/passwd', path.join(up, 'link'));
        const dump = options.dump ?? goodDump();
        writeFileSync(path.join(work, 'mongo.archive.gz'), dump);
        const bytes = Object.values(files).reduce((n, d) => n + d.length, 0);
        const manifest = {
            format: 1,
            id: options.id ?? '64b64c1f1c9a4f0e5a1b2c3d',
            created_at: new Date().toISOString(),
            day: '2026-01-01',
            kind: 'daily',
            trigger: 'manual',
            app_version: options.appVersion ?? APP,
            based_on: null,
            db: {
                name: options.dbName ?? 'scribo',
                archive: 'mongo.archive.gz',
                sha256:
                    options.sha ??
                    createHash('sha256').update(dump).digest('hex'),
                bytes: dump.length,
                collections: ['posts', 'users'],
                ...(options.dbVersion === null
                    ? {}
                    : { version: options.dbVersion ?? dbVersionOf(APP) }),
            },
            uploads: {
                dir: 'uploads',
                files: Object.keys(files).length,
                bytes,
            },
        };
        writeFileSync(
            path.join(work, 'manifest.json'),
            JSON.stringify(manifest),
        );
        const archive = path.join(base, 'backup.tar');
        execFileSync('tar', [
            '-cf',
            archive,
            '-C',
            work,
            'manifest.json',
            'mongo.archive.gz',
            '-C',
            base,
            'uploads',
        ]);
        return archive;
    };

    const uploadResult = (
        source: string,
        name = 'backup.tar',
        userId?: string,
    ) => {
        const temp = path.join(dir, `.upload-${counter++}.partial`);
        execFileSync('cp', [source, temp]);
        return imports.importFile({
            tempPath: temp,
            originalName: name,
            size: statSync(temp).size,
            userId,
        });
    };
    const upload = async (source: string, name?: string, userId?: string) =>
        (await uploadResult(source, name, userId)).record;

    const leftovers = () => readdirSync(dir).filter((n) => n.startsWith('.'));

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), 'scribo-upload-'));
        dir = path.join(root, 'backups');
        uploads = path.join(root, 'uploads');
        bin = path.join(root, 'bin');
        calls = path.join(root, 'restore-calls');
        mkdirSync(dir);
        mkdirSync(bin);
        mkdirSync(path.join(uploads, 'src'), { recursive: true });
        for (const name of ['mongodump', 'mongorestore']) {
            const file = path.join(bin, name);
            writeFileSync(file, `#!/bin/sh\necho "$@" >> "${calls}"\n`);
            chmodSync(file, 0o755);
        }
        model = fakeModel();
        logger = fakeLogger();
        build();
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it('accepts a valid archive and lists it as uploaded', async () => {
        const record = await upload(
            makeArchive(),
            'my-backup.tar',
            '64b64c1f1c9a4f0e5a1b2c3d',
        );

        expect(record).toMatchObject({
            kind: 'uploaded',
            trigger: 'upload',
            status: 'success',
            source_id: '64b64c1f1c9a4f0e5a1b2c3d',
            source: {
                original_name: 'my-backup.tar',
                app_version: APP,
                db_version: dbVersionOf(APP),
                db_name: 'scribo',
                trigger: 'manual',
            },
            contents: { db_name: 'scribo', collections: 2, uploads_files: 1 },
        });
        expect(record.file_name).toMatch(
            /^scribo-upload-\d{8}-\d{6}-\w+\.tar$/,
        );
        expect(readdirSync(dir)).toEqual([record.file_name]);
        expect(backups.status().running).toBe(false);
    });

    it('installs an uploaded archive with the id from its own manifest', async () => {
        const record = await upload(makeArchive());
        expect(record._id).not.toBe(record.source_id);

        await restore.start(String(record._id), null);
        for (let i = 0; i < 300 && backups.status().restoring; i++) {
            await new Promise((r) => setTimeout(r, 20));
        }

        expect(restore['job']).toMatchObject({ status: 'success' });
        expect(existsSync(path.join(uploads, 'src/a.png'))).toBe(true);
    });

    it('rejects a file that is not a tar archive and leaves nothing behind', async () => {
        const junk = path.join(root, 'junk.tar');
        writeFileSync(junk, 'this is not an archive '.repeat(100));
        await expect(upload(junk)).rejects.toThrow(/Not a tar archive/);
        expect(model.docs).toHaveLength(0);
        expect(leftovers().filter((n) => n.startsWith('.work-'))).toEqual([]);
        expect(backups.status().running).toBe(false);
    });

    it('goes by the content, not the file name', async () => {
        const record = await upload(makeArchive(), 'backup.gz');
        expect(record.source).toMatchObject({ original_name: 'backup.gz' });
    });

    it('takes an archive made in another database and installs it under the current name', async () => {
        const record = await upload(makeArchive({ dbName: 'dev' }));
        expect(record.source).toMatchObject({ db_name: 'dev' });
        expect(record.contents).toMatchObject({ db_name: 'dev' });

        await restore.start(String(record._id), null);
        for (let i = 0; i < 300 && backups.status().restoring; i++) {
            await new Promise((r) => setTimeout(r, 20));
        }

        expect(restore['job']).toMatchObject({ status: 'success' });
        const first =
            readFileSync(calls, 'utf8')
                .split('\n')
                .find((line) => line.includes('--nsInclude')) ?? '';
        expect(first).toContain('--nsInclude=dev.*');
        expect(first).toContain('--nsExclude=dev.backups');
        expect(first).toContain('--nsFrom=dev.$col$');
        expect(first).toContain('--nsTo=scribo.$col$');
    });

    it('does not rename anything when the database name is the same', async () => {
        const record = await upload(makeArchive());
        await restore.start(String(record._id), null);
        for (let i = 0; i < 300 && backups.status().restoring; i++) {
            await new Promise((r) => setTimeout(r, 20));
        }
        expect(readFileSync(calls, 'utf8')).not.toContain('--nsFrom');
    });

    it('rejects an archive with another data version', async () => {
        const major = Number(APP.split('.')[0]);
        await expect(
            upload(makeArchive({ dbVersion: `${major + 1}.0` })),
        ).rejects.toThrow(/data version \d+\.0, this system works with/);
        expect(model.docs).toHaveLength(0);
    });

    it('accepts an archive from a different patch of the same version', async () => {
        const [major, minor] = APP.split('.');
        const record = await upload(
            makeArchive({ appVersion: `${major}.${minor}.99` }),
        );
        expect(record.contents).toMatchObject({
            app_version: `${major}.${minor}.99`,
        });
    });

    it('works out the data version of an old archive from its backend version', async () => {
        const record = await upload(makeArchive({ dbVersion: null }));
        expect(record.contents!.db_version).toBe(dbVersionOf(APP));

        await expect(
            upload(
                makeArchive({
                    dbVersion: null,
                    appVersion: '1.0.0',
                    id: '64b64c1f1c9a4f0e5a1b2c09',
                }),
            ),
        ).rejects.toThrow(/data version 1\.0/);
        await expect(
            upload(
                makeArchive({
                    dbVersion: null,
                    appVersion: 'unknown',
                    id: '64b64c1f1c9a4f0e5a1b2c08',
                }),
            ),
        ).rejects.toThrow(/data version unknown/);
    });

    it('rejects a dump whose checksum does not match the manifest', async () => {
        await expect(
            upload(makeArchive({ sha: 'a'.repeat(64) })),
        ).rejects.toThrow(/checksum/);
    });

    it('rejects a dump that is not a mongodump archive', async () => {
        await expect(
            upload(makeArchive({ dump: gzipSync(Buffer.from('hello')) })),
        ).rejects.toThrow(/not a mongodump archive/);
        await expect(
            upload(makeArchive({ dump: Buffer.from('plain bytes') })),
        ).rejects.toThrow(/valid gzip/);
    });

    it('rejects symbolic links inside the archive', async () => {
        await expect(upload(makeArchive({ link: true }))).rejects.toThrow(
            /unsupported entry/,
        );
    });

    it('rejects paths that climb out of the target directory', async () => {
        const evil = path.join(root, 'evil.tar');
        writeFileSync(evil, rawTar([{ name: '../evil', data: 'x' }]));
        await expect(upload(evil)).rejects.toThrow(/unsafe path/);

        writeFileSync(evil, rawTar([{ name: '/etc/cron.d/x', data: 'x' }]));
        await expect(upload(evil)).rejects.toThrow(/unsafe path/);
    });

    it('rejects extra files that are not part of a backup', async () => {
        const manifestless = path.join(root, 'plain.tar');
        writeFileSync(
            manifestless,
            rawTar([{ name: 'readme.txt', data: 'x' }]),
        );
        await expect(upload(manifestless)).rejects.toThrow(
            /manifest.json is missing/,
        );
    });

    it('rejects an uploads folder that disagrees with the manifest', async () => {
        const archive = makeArchive();
        const base = path.dirname(archive);
        writeFileSync(path.join(base, 'uploads/src/extra.png'), 'more');
        execFileSync('tar', [
            '-cf',
            archive,
            '-C',
            path.join(base, 'work'),
            'manifest.json',
            'mongo.archive.gz',
            '-C',
            base,
            'uploads',
        ]);
        await expect(upload(archive)).rejects.toThrow(
            /do not match the manifest/,
        );
    });

    it('does not take the same backup twice and points to the one in the list', async () => {
        const archive = makeArchive();
        const first = await uploadResult(archive);
        expect(first.duplicate).toBe(false);

        const again = await uploadResult(archive);
        expect(again.duplicate).toBe(true);
        expect(String(again.record._id)).toBe(String(first.record._id));
        expect(model.docs).toHaveLength(1);
        expect(
            readdirSync(dir).filter((n) => n.startsWith('scribo-upload-')),
        ).toHaveLength(1);
    });

    it('refuses while another backup or restore holds the lock', async () => {
        backups.acquire('restore');
        await expect(upload(makeArchive())).rejects.toThrow(/already running/);
        backups.release();
    });

    it('refuses when restore is disabled', async () => {
        build({ BACKUP_RESTORE_ENABLED: 'false' });
        await expect(upload(makeArchive())).rejects.toThrow(/disabled/);
    });

    it('keeps only the configured number of uploaded archives', async () => {
        await upload(makeArchive({ id: '64b64c1f1c9a4f0e5a1b2c01' }));
        await new Promise((r) => setTimeout(r, 1100));
        await upload(makeArchive({ id: '64b64c1f1c9a4f0e5a1b2c02' }));

        const uploaded = model.docs.filter((d) => d.kind === 'uploaded');
        expect(uploaded).toHaveLength(2);
        expect(uploaded.filter((d) => !d.file_removed_at)).toHaveLength(1);
        expect(readdirSync(dir)).toHaveLength(1);
    });
});
