import {
    ConflictException,
    Injectable,
    NotFoundException,
    OnModuleInit,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { cp, mkdir, readdir, rm, writeFile } from 'fs/promises';
import { Connection } from 'mongoose';
import path from 'path';
import { redact, uriWithoutDb } from './backups.config';
import {
    actorFields,
    LoggerService,
    type LogActor,
} from '../../infra/logger.service';
import { BackupsService } from './backups.service';
import {
    readLock,
    readState,
    recordRestore,
    removeLock,
    writeLock,
    type RestoreOutcome,
} from './backups.state';
import { verifyArchive } from './archive';
import { incompatibility, syncDbMeta } from './db-version';
import { MONGO_ARCHIVE, appVersion, type Manifest } from './manifest';
import { runProcess } from './run-process';

const MAX_ENTRIES = 500_000;

export type RestorePhase =
    'verifying' | 'snapshot' | 'database' | 'files' | 'rollback';

export type RestoreJob = {
    backup_id: string;
    file_name: string;
    phase: RestorePhase;
    status: 'running' | 'success' | 'failed';
    started_at: string;
    finished_at: string | null;
    error: string | null;
    rolled_back: boolean;
};

@Injectable()
export class BackupRestoreService implements OnModuleInit {
    private job: RestoreJob | null = null;

    constructor(
        private readonly archives: BackupsService,
        @InjectConnection() private readonly connection: Connection,
        private readonly logger: LoggerService,
    ) {}

    private get dir() {
        return this.archives.settings.dir;
    }

    async onModuleInit() {
        const lock = await readLock(this.dir);
        if (!lock) return;
        await recordRestore(this.dir, {
            backup_id: lock.backup_id,
            file_name: lock.file_name,
            started_at: lock.started_at,
            finished_at: new Date().toISOString(),
            restored_by: lock.restored_by,
            status: 'interrupted',
            rolled_back: false,
            safety_backup_id: lock.safety_backup_id,
            error: 'The process stopped during the restore: the database and files may be half restored',
        });
        await removeLock(this.dir);
    }

    async details() {
        const state = await readState(this.dir);
        return {
            current: state.current,
            last_restore: state.last_restore,
            restore_job: this.job,
        };
    }

    async start(id: string, userId: string | null, author?: LogActor) {
        const cfg = this.archives.settings;
        if (!cfg.restoreEnabled) {
            throw new ConflictException('Restore is disabled');
        }
        const record = await this.archives.findRecord(id);
        if (
            !record ||
            record.status !== 'success' ||
            !record.file_name ||
            record.file_removed_at
        ) {
            throw new NotFoundException('Backup file not found');
        }
        if (!record.contents) {
            throw new ConflictException(
                'This archive has no manifest, it cannot be restored',
            );
        }
        if (record.contents.db_version !== undefined) {
            const mismatch = incompatibility(
                record.contents.db_version,
                this.archives.currentDbVersion(),
            );
            if (mismatch) throw new ConflictException(mismatch);
        }
        if (!this.archives.acquire('restore')) {
            throw new ConflictException(
                'A backup or a restore is already running',
            );
        }
        const job: RestoreJob = {
            backup_id: String(record._id),
            file_name: record.file_name,
            phase: 'verifying',
            status: 'running',
            started_at: new Date().toISOString(),
            finished_at: null,
            error: null,
            rolled_back: false,
        };
        this.job = job;
        void this.run(job, userId, author, record.source_id ?? job.backup_id);
        return job;
    }

    private async run(
        job: RestoreJob,
        userId: string | null,
        author: LogActor | undefined,
        manifestId: string,
    ) {
        const file = this.archives.pathOf(job.file_name);
        const work = this.archives.pathOf(
            `.restore-${randomBytes(6).toString('hex')}`,
        );
        let safetyId: string | null = null;
        let safetyFile: string | null = null;
        let touched = false;
        let manifest: Manifest | null = null;
        let error: string | null = null;
        try {
            await writeLock(this.dir, {
                backup_id: job.backup_id,
                file_name: job.file_name,
                started_at: job.started_at,
                restored_by: userId,
                safety_backup_id: null,
            });
            manifest = await this.extractAndVerify(file, work, manifestId);

            job.phase = 'snapshot';
            const safety = await this.archives.snapshot(userId ?? undefined);
            safetyId = String(safety._id);
            const fresh = await this.archives.findRecord(safetyId);
            safetyFile = fresh?.file_name ?? null;
            await this.archives
                .prune()
                .catch((e) => console.error('backup prune failed', e));
            await writeLock(this.dir, {
                backup_id: job.backup_id,
                file_name: job.file_name,
                started_at: job.started_at,
                restored_by: userId,
                safety_backup_id: safetyId,
            });

            touched = true;
            await this.install(work, manifest, job);
        } catch (e) {
            error = redact(e instanceof Error ? e.message : String(e));
            if (touched && safetyFile) {
                job.phase = 'rollback';
                try {
                    const back = this.archives.pathOf(
                        `.restore-${randomBytes(6).toString('hex')}`,
                    );
                    try {
                        const m = await this.extractAndVerify(
                            this.archives.pathOf(safetyFile),
                            back,
                            safetyId!,
                        );
                        await this.install(back, m, job);
                        job.rolled_back = true;
                    } finally {
                        await rm(back, { recursive: true, force: true });
                    }
                } catch (rollbackError) {
                    error += ` | rollback failed: ${redact(
                        rollbackError instanceof Error
                            ? rollbackError.message
                            : String(rollbackError),
                    )}. Restore the safety snapshot ${safetyFile} manually`;
                }
            }
        } finally {
            await rm(work, { recursive: true, force: true });
            const finishedAt = new Date().toISOString();
            job.finished_at = finishedAt;
            job.status = error ? 'failed' : 'success';
            job.error = error;
            const outcome: RestoreOutcome = {
                backup_id: job.backup_id,
                file_name: job.file_name,
                started_at: job.started_at,
                finished_at: finishedAt,
                restored_by: userId,
                status: error ? 'failed' : 'success',
                rolled_back: job.rolled_back,
                safety_backup_id: safetyId,
                error,
            };
            await recordRestore(
                this.dir,
                outcome,
                !error && manifest
                    ? {
                          backup_id: job.backup_id,
                          file_name: job.file_name,
                          day: manifest.day,
                          taken_at: manifest.created_at,
                          restored_at: finishedAt,
                          restored_by: userId,
                      }
                    : undefined,
            ).catch((e) => console.error('restore state not saved', e));
            await removeLock(this.dir);
            if (!error) {
                await syncDbMeta(this.connection, appVersion()).catch((e) =>
                    console.error('database version was not synced', e),
                );
            }
            let safetyRemoved = false;
            if (!error && safetyId) {
                safetyRemoved = await this.archives
                    .discardSnapshot(safetyId)
                    .then(() => true)
                    .catch((e) => {
                        console.error('safety snapshot not removed', e);
                        return false;
                    });
            }
            await this.logger.log({
                type: 'backup_restore_result',
                message: error
                    ? `Restore of ${job.file_name} failed${job.rolled_back ? ' (rolled back)' : ''}: ${error}`
                    : `Restore of ${job.file_name} finished`,
                level: error ? 'error' : 'info',
                data: {
                    ...(author
                        ? actorFields(author)
                        : {
                              system: true,
                              ...(userId ? { user: userId } : {}),
                          }),
                    backup: job.backup_id,
                    file_name: job.file_name,
                    status: error ? 'failed' : 'success',
                    rolled_back: job.rolled_back,
                    safety_backup: safetyId,
                    safety_removed: safetyRemoved,
                    error,
                },
            });
            this.archives.release();
        }
    }

    private extractAndVerify(
        file: string,
        work: string,
        expectedId: string,
    ): Promise<Manifest> {
        return verifyArchive({
            tar: this.archives.settings.tar,
            file,
            work,
            dbVersion: this.archives.currentDbVersion(),
            expectedId,
            limits: { maxEntries: MAX_ENTRIES, maxBytes: Infinity },
        });
    }

    private async install(work: string, manifest: Manifest, job: RestoreJob) {
        job.phase = 'database';
        await this.restoreDatabase(work, manifest);
        job.phase = 'files';
        await this.replaceUploads(work, manifest);
    }

    private async restoreDatabase(work: string, manifest: Manifest) {
        const cfg = this.archives.settings;
        const db = manifest.db.name;
        const target = this.connection.name;
        const conf = this.archives.pathOf(
            `.uri.${randomBytes(6).toString('hex')}`,
        );
        try {
            await writeFile(
                conf,
                `uri: '${uriWithoutDb(this.archives.connectionUri()).replace(/'/g, "''")}'\n`,
                { mode: 0o600 },
            );
            await runProcess(cfg.mongorestore, [
                `--config=${conf}`,
                '--gzip',
                `--archive=${path.join(work, MONGO_ARCHIVE)}`,
                '--drop',
                `--nsInclude=${db}.*`,
                `--nsExclude=${db}.backups`,
                ...(db === target
                    ? []
                    : [`--nsFrom=${db}.$col$`, `--nsTo=${target}.$col$`]),
                '--stopOnError',
                '--numParallelCollections=1',
            ]);
        } finally {
            await rm(conf, { force: true });
        }

        const handle = this.connection.db;
        if (!handle) return;
        const known = new Set(manifest.db.collections);
        for (const item of await handle
            .listCollections({}, { nameOnly: true })
            .toArray()) {
            if (
                item.name === 'backups' ||
                item.name.startsWith('system.') ||
                known.has(item.name)
            ) {
                continue;
            }
            await handle.dropCollection(item.name);
        }
    }

    private async replaceUploads(work: string, manifest: Manifest) {
        const dest = this.archives.settings.uploadsDir;
        await mkdir(dest, { recursive: true });
        for (const name of await readdir(dest)) {
            await rm(path.join(dest, name), { recursive: true, force: true });
        }
        await cp(path.join(work, manifest.uploads.dir), dest, {
            recursive: true,
        });
    }
}
