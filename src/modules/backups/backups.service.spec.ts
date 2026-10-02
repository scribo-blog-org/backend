import { ConfigService } from '@nestjs/config';
import { execFileSync } from 'child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { BackupsService } from './backups.service';
import { fakeConnection, fakeLogger, fakeModel } from './backups.test-utils';

describe('BackupsService', () => {
    let dir: string;
    let bin: string;
    let uploads: string;
    let dumpBin = '';

    const service = (model: ReturnType<typeof fakeModel>, enabled = true) =>
        new BackupsService(
            new ConfigService({
                BACKUP_ENABLED: enabled ? 'true' : 'false',
                BACKUPS_DIR: dir,
                UPLOADS_DIR: uploads,
                MONGODUMP_BIN: dumpBin,
                MONGODB_URI: "mongodb+srv://u:p'w@host/db",
            }),
            model as any,
            fakeConnection() as any,
            fakeLogger() as any,
        );

    const idle = async (svc: BackupsService) => {
        for (let i = 0; i < 200; i++) {
            if (!svc.status().running) return;
            await new Promise((r) => setTimeout(r, 20));
        }
        throw new Error('backup did not finish');
    };

    const fakeDump = (script: string) => {
        const file = path.join(bin, 'mongodump');
        writeFileSync(file, `#!/bin/sh\n${script}\n`);
        chmodSync(file, 0o755);
        dumpBin = file;
    };

    const list = (archive: string) =>
        execFileSync('tar', ['-tf', archive])
            .toString()
            .split('\n')
            .filter(Boolean)
            .map((line) => line.replace(/\/$/, ''))
            .sort();

    beforeEach(() => {
        dir = mkdtempSync(path.join(tmpdir(), 'scribo-backups-'));
        bin = mkdtempSync(path.join(tmpdir(), 'scribo-bin-'));
        uploads = path.join(
            mkdtempSync(path.join(tmpdir(), 'scribo-up-')),
            'uploads',
        );
        mkdirSync(path.join(uploads, 'src'), { recursive: true });
        writeFileSync(path.join(uploads, 'src', 'a.png'), 'img');
    });

    afterEach(() => {
        for (const d of [dir, bin, path.dirname(uploads)]) {
            rmSync(d, { recursive: true, force: true });
        }
    });

    it('packs the Mongo dump and the uploads into one dated archive', async () => {
        fakeDump('printf "dump-bytes"');
        const model = fakeModel();
        const svc = service(model);
        const record = await svc.start('manual', '64b64c1f1c9a4f0e5a1b2c3d');
        expect(record.status).toBe('running');
        await idle(svc);

        const doc = model.docs[0];
        expect(doc.status).toBe('success');
        expect(doc.file_name).toMatch(/^scribo-\d{8}-\d{6}\.tar$/);
        expect(readdirSync(dir)).toEqual([doc.file_name]);
        expect(list(path.join(dir, doc.file_name))).toEqual([
            'manifest.json',
            'mongo.archive.gz',
            'uploads',
            'uploads/src',
            'uploads/src/a.png',
        ]);
    });

    it("a manual run adds a backup on top of today's and keeps both", async () => {
        fakeDump('printf "first"');
        const model = fakeModel();
        const svc = service(model);
        await svc.start('schedule');
        await idle(svc);
        // Имя строится по секундам: два бекапа подряд в одну секунду невозможны,
        // но в тесте они идут вплотную.
        await new Promise((r) => setTimeout(r, 1100));
        writeFileSync(path.join(uploads, 'src', 'b.png'), 'img');
        await svc.start('manual');
        await idle(svc);

        expect(readdirSync(dir)).toHaveLength(2);
        expect(model.docs.every((d) => !d.file_removed_at)).toBe(true);
        expect(list(path.join(dir, model.docs[0].file_name))).not.toContain(
            'uploads/src/b.png',
        );
        expect(list(path.join(dir, model.docs[1].file_name))).toContain(
            'uploads/src/b.png',
        );
    });

    it('after a new backup keeps one backup for each past day, and all of today', async () => {
        fakeDump('printf "dump"');
        const model = fakeModel();
        const svc = service(model);
        const day = new Date(Date.now() - 3 * 86_400_000)
            .toISOString()
            .slice(0, 10);
        const old = ['04:00', '20:00'].map((time, i) => {
            const file = `scribo-old-${i}.tar`;
            writeFileSync(path.join(dir, file), 'x');
            const doc = {
                _id: `old${i}`,
                status: 'success',
                kind: 'daily',
                started_at: new Date(`${day}T${time}:00Z`),
                file_name: file,
                file_removed_at: null,
            };
            model.docs.push(doc);
            return doc;
        });

        await svc.start('manual');
        await idle(svc);

        expect(old[0].file_removed_at).toBeTruthy();
        expect((old[0] as any).file_removed_reason).toBe('rotation');
        expect(existsSync(path.join(dir, 'scribo-old-0.tar'))).toBe(false);
        expect(old[1].file_removed_at).toBeNull();
        expect(existsSync(path.join(dir, 'scribo-old-1.tar'))).toBe(true);
    });

    it('a failed run keeps the existing backup of the day', async () => {
        fakeDump('printf "first"');
        const model = fakeModel();
        const svc = service(model);
        await svc.start('schedule');
        await idle(svc);
        fakeDump('exit 1');
        await svc.start('manual');
        await idle(svc);

        expect(model.docs[1].status).toBe('failed');
        expect(model.docs[0].file_removed_at ?? null).toBeNull();
        expect(existsSync(path.join(dir, model.docs[0].file_name))).toBe(true);
        expect(readdirSync(dir)).toEqual([model.docs[0].file_name]);
    });

    it('records failure with redacted stderr and leaves no temp files', async () => {
        fakeDump(
            'echo "cannot connect mongodb+srv://u:secret@host/db" >&2; exit 3',
        );
        const model = fakeModel();
        const svc = service(model);
        await svc.start('manual');
        await idle(svc);

        expect(model.docs[0].status).toBe('failed');
        expect(model.docs[0].error).toContain('code 3');
        expect(model.docs[0].error).toContain('mongodb+srv://***@');
        expect(model.docs[0].error).not.toContain('secret');
        expect(readdirSync(dir)).toEqual([]);
    });

    it('does not pass the password in argv', async () => {
        fakeDump('echo "$@" >&2; exit 1');
        const model = fakeModel();
        const svc = service(model);
        await svc.start('manual');
        await idle(svc);
        expect(model.docs[0].error).not.toContain("p'w");
    });

    it('rejects a second start while one is running', async () => {
        fakeDump('sleep 1; printf x');
        const model = fakeModel();
        const svc = service(model);
        await svc.start('manual');
        await expect(svc.start('manual')).rejects.toThrow('already running');
        await idle(svc);
    });

    it('refuses to start when disabled', async () => {
        const svc = service(fakeModel(), false);
        await expect(svc.start('manual')).rejects.toThrow('disabled');
    });
});
