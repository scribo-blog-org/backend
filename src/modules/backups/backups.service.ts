import {
    ConflictException,
    Injectable,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { createReadStream } from 'fs';
import {
    chmod,
    mkdir,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { Connection, Model, Types } from 'mongoose';
import path from 'path';
import { mongoUri } from '../../config/startup';
import {
    actorFields,
    LoggerService,
    type LogActor,
    type LogLevel,
} from '../../infra/logger.service';
import {
    Backup,
    type BackupTrigger,
} from '../../database/schemas/backup.schema';
import { paginationMeta, parsePagination } from '../../http/pagination';
import {
    backupsConfig,
    expiredBackups,
    msUntilNextRun,
    redact,
    tarAccepted,
    utcDay,
    type BackupsConfig,
} from './backups.config';
import { dbVersionOf, incompatibility, readDbMeta } from './db-version';
import { readState } from './backups.state';
import {
    MANIFEST_FILE,
    MANIFEST_VERSION,
    MONGO_ARCHIVE,
    appVersion,
    dirStats,
    manifestDbVersion,
    sha256File,
    type BackupKind,
    type Manifest,
} from './manifest';
import { runProcess } from './run-process';

const MAX_TIMER_MS = 2 ** 31 - 1;

type Busy = 'backup' | 'restore' | null;

type RunTrigger = Exclude<BackupTrigger, 'upload'>;

const fileStamp = () =>
    new Date()
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\..*/, '')
        .replace('T', '-');

@Injectable()
export class BackupsService implements OnModuleInit, OnModuleDestroy {
    private readonly cfg: BackupsConfig;
    private readonly uri: () => string;
    private timer: NodeJS.Timeout | null = null;
    private busy: Busy = null;

    constructor(
        config: ConfigService,
        @InjectModel(Backup.name) private readonly backups: Model<Backup>,
        @InjectConnection() private readonly connection: Connection,
        private readonly logger: LoggerService,
    ) {
        this.cfg = backupsConfig(config);
        this.uri = () => mongoUri(config);
    }

    get settings(): BackupsConfig {
        return this.cfg;
    }

    connectionUri(): string {
        return this.uri();
    }

    async onModuleInit() {
        await this.backups.updateMany(
            { status: 'running' },
            {
                status: 'failed',
                finished_at: new Date(),
                error: 'Interrupted: the process stopped during the backup',
            },
        );
        if (!this.cfg.enabled) return;
        await mkdir(this.cfg.dir, { recursive: true, mode: 0o700 });
        await this.removeLeftovers();
        this.scheduleNext();
    }

    onModuleDestroy() {
        if (this.timer) clearTimeout(this.timer);
    }

    acquire(kind: 'backup' | 'restore'): boolean {
        if (this.busy) return false;
        this.busy = kind;
        return true;
    }

    release() {
        this.busy = null;
    }

    isRestoring() {
        return this.busy === 'restore';
    }

    status() {
        const { hour, minute } = this.cfg.at;
        const pad = (n: number) => String(n).padStart(2, '0');
        return {
            enabled: this.cfg.enabled,
            restore_enabled: this.cfg.restoreEnabled,
            running: this.busy === 'backup',
            restoring: this.busy === 'restore',
            schedule_at_utc: this.cfg.enabled
                ? `${pad(hour)}:${pad(minute)}`
                : null,
            keep_daily_days: this.cfg.keepDailyDays,
            keep_months: this.cfg.keepMonths,
            db_name: this.connection.name,
            app_version: appVersion(),
            db_version: this.currentDbVersion(),
            upload_enabled: this.cfg.restoreEnabled,
            upload_max_bytes: this.cfg.uploadMaxBytes,
            keep_uploaded: this.cfg.keepUploaded,
        };
    }

    currentDbVersion(): string | null {
        return dbVersionOf(appVersion());
    }

    async list(query: { page?: number; limit?: number }) {
        const { page, limit, skip } = parsePagination(query, 10, 50);
        const [total, items] = await Promise.all([
            this.backups.countDocuments(),
            this.backups
                .find()
                .sort({ started_at: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
        ]);
        return {
            status: this.status(),
            items: items.map((item) => {
                const hasFile =
                    item.status === 'success' &&
                    Boolean(item.file_name) &&
                    !item.file_removed_at;
                const blocked =
                    item.contents?.db_version !== undefined
                        ? incompatibility(
                              item.contents.db_version,
                              this.currentDbVersion(),
                          )
                        : null;
                return {
                    ...item,
                    can_download: hasFile,
                    can_restore:
                        this.cfg.restoreEnabled &&
                        hasFile &&
                        Boolean(item.contents) &&
                        !blocked,
                    restore_blocked: hasFile ? blocked : null,
                };
            }),
            pagination: paginationMeta(page, limit, total),
        };
    }

    async start(trigger: RunTrigger, userId?: string, author?: LogActor) {
        if (!this.cfg.enabled) {
            throw new ConflictException('Backups are disabled');
        }
        if (!this.acquire('backup')) {
            throw new ConflictException(
                this.busy === 'restore'
                    ? 'A restore is in progress'
                    : 'A backup is already running',
            );
        }
        let record;
        try {
            record = await this.createRecord('daily', trigger, userId);
        } catch (error) {
            this.release();
            throw error;
        }
        void this.runAndRelease(record._id, record.day, trigger, author);
        return record.toObject();
    }

    async snapshot(userId?: string) {
        const record = await this.createRecord('pre_restore', 'manual', userId);
        const error = await this.produce(
            record._id,
            record.day,
            'pre_restore',
            'restore',
        );
        if (error) throw new Error(`Safety snapshot failed: ${error}`);
        return record;
    }

    async findRecord(id: string) {
        return Types.ObjectId.isValid(id)
            ? await this.backups.findById(id).lean()
            : null;
    }

    pathOf(name: string): string {
        return this.resolve(name);
    }

    async openFile(id: string) {
        const record = Types.ObjectId.isValid(id)
            ? await this.backups.findById(id)
            : null;
        if (
            !record ||
            record.status !== 'success' ||
            !record.file_name ||
            record.file_removed_at
        ) {
            throw new NotFound();
        }
        const file = this.resolve(record.file_name);
        const size = await stat(file)
            .then((s) => s.size)
            .catch(() => null);
        if (size === null) {
            await this.backups.updateOne(
                { _id: record._id },
                { file_removed_at: new Date() },
            );
            throw new NotFound();
        }
        return {
            name: record.file_name,
            size,
            stream: createReadStream(file),
        };
    }

    async listedArchive(manifestId: string) {
        const own = await this.findRecord(manifestId);
        if (own && own.status === 'success' && !own.file_removed_at) {
            return own;
        }
        const [copy] = await this.backups
            .find({ source_id: manifestId, file_removed_at: null })
            .lean();
        return copy ?? null;
    }

    async adopt(
        tempPath: string,
        manifest: Manifest,
        meta: { userId?: string; originalName: string },
    ) {
        const fileName = `scribo-upload-${fileStamp()}-${randomBytes(2).toString('hex')}.tar`;
        const target = this.resolve(fileName);
        await rename(tempPath, target);
        await chmod(target, 0o600);
        const { size } = await stat(target);
        const now = new Date();
        let record;
        try {
            record = await this.backups.create({
                day: manifest.day,
                kind: 'uploaded',
                trigger: 'upload',
                triggered_by: meta.userId
                    ? new Types.ObjectId(meta.userId)
                    : null,
                status: 'success',
                started_at: now,
                finished_at: now,
                file_name: fileName,
                size_bytes: size,
                source_id: manifest.id,
                source: {
                    created_at: manifest.created_at,
                    app_version: manifest.app_version,
                    db_version: manifestDbVersion(manifest),
                    db_name: manifest.db.name,
                    trigger: manifest.trigger,
                    kind: manifest.kind,
                    original_name: meta.originalName,
                },
                contents: {
                    db_name: manifest.db.name,
                    collections: manifest.db.collections.length,
                    db_bytes: manifest.db.bytes,
                    uploads_files: manifest.uploads.files,
                    uploads_bytes: manifest.uploads.bytes,
                    based_on: manifest.based_on,
                    app_version: manifest.app_version,
                    db_version: manifestDbVersion(manifest),
                },
            });
        } catch (error) {
            await rm(target, { force: true });
            throw error;
        }
        await this.prune().catch((e) =>
            console.error('backup prune failed', e),
        );
        return record.toObject();
    }

    private createRecord(
        kind: BackupKind,
        trigger: BackupTrigger,
        userId?: string,
    ) {
        const startedAt = new Date();
        return this.backups.create({
            day: utcDay(startedAt),
            kind,
            trigger,
            triggered_by: userId ? new Types.ObjectId(userId) : null,
            status: 'running',
            started_at: startedAt,
        });
    }

    private scheduleNext(from = new Date()) {
        const delay = Math.min(msUntilNextRun(this.cfg.at, from), MAX_TIMER_MS);
        this.timer = setTimeout(() => {
            this.start('schedule').catch((error) =>
                console.error('scheduled backup was not started', error),
            );
            this.scheduleNext(new Date(Date.now() + 60_000));
        }, delay);
        this.timer.unref();
    }

    private async runAndRelease(
        id: Types.ObjectId,
        day: string,
        trigger: RunTrigger,
        author?: LogActor,
    ) {
        try {
            const error = await this.produce(id, day, 'daily', trigger);
            if (error) {
                await this.logEvent(
                    'backup_failed',
                    `Backup failed (${trigger}): ${error}`,
                    author,
                    { trigger, backup: String(id), error },
                    'error',
                );
            } else {
                const record = await this.findRecord(String(id));
                await this.logEvent(
                    'backup_done',
                    `Backup ${record?.file_name ?? id} finished (${trigger})`,
                    author,
                    {
                        trigger,
                        backup: String(id),
                        file_name: record?.file_name ?? null,
                        size_bytes: record?.size_bytes ?? null,
                    },
                );
            }
            const removed = await this.prune().catch((e) => {
                console.error('backup prune failed', e);
                return 0;
            });
            if (removed > 0) {
                await this.logger.system(
                    'backup_rotated',
                    `Backup rotation removed ${removed} file(s)`,
                    { removed_files: removed },
                );
            }
        } finally {
            this.release();
        }
    }

    private logEvent(
        type: string,
        message: string,
        author: LogActor | undefined,
        data: Record<string, unknown>,
        level?: LogLevel,
    ) {
        return this.logger.log({
            type,
            message,
            level,
            data: {
                ...(author ? actorFields(author) : { system: true }),
                ...data,
            },
        });
    }

    private async produce(
        id: Types.ObjectId,
        day: string,
        kind: BackupKind,
        trigger: Manifest['trigger'],
    ): Promise<string | null> {
        const stamp = fileStamp();
        const fileName =
            kind === 'daily'
                ? `scribo-${stamp}.tar`
                : `scribo-pre-restore-${stamp}-${randomBytes(2).toString('hex')}.tar`;
        const target = this.resolve(fileName);
        const partial = this.resolve(`.${fileName}.partial`);
        const work = this.resolve(`.work-${randomBytes(6).toString('hex')}`);
        const conf = this.resolve(`.uri.${randomBytes(6).toString('hex')}`);
        try {
            await mkdir(work, { recursive: true, mode: 0o700 });
            await writeFile(
                conf,
                `uri: '${this.uri().replace(/'/g, "''")}'\n`,
                { mode: 0o600 },
            );
            const dump = path.join(work, MONGO_ARCHIVE);
            await runProcess(
                this.cfg.mongodump,
                [
                    `--config=${conf}`,
                    '--gzip',
                    '--archive',
                    '--numParallelCollections=1',
                ],
                { out: dump },
            );
            await mkdir(this.cfg.uploadsDir, { recursive: true });

            const uploadsBase = path.basename(this.cfg.uploadsDir);
            const [dumpStat, dumpHash, uploads, collections, state] =
                await Promise.all([
                    stat(dump),
                    sha256File(dump),
                    dirStats(this.cfg.uploadsDir),
                    this.collectionNames(),
                    readState(this.cfg.dir),
                ]);
            const meta = await readDbMeta(this.connection).catch(() => null);
            const manifest: Manifest = {
                format: MANIFEST_VERSION,
                id: String(id),
                created_at: new Date().toISOString(),
                day,
                kind,
                trigger,
                app_version: appVersion(),
                based_on: state.current?.backup_id ?? null,
                db: {
                    name: this.connection.name,
                    archive: MONGO_ARCHIVE,
                    sha256: dumpHash,
                    bytes: dumpStat.size,
                    collections,
                    version: meta?.version ?? this.currentDbVersion(),
                },
                uploads: { dir: uploadsBase, ...uploads },
            };
            await writeFile(
                path.join(work, MANIFEST_FILE),
                JSON.stringify(manifest, null, 2),
            );

            await runProcess(
                this.cfg.tar,
                [
                    '-cf',
                    '-',
                    '-C',
                    work,
                    MANIFEST_FILE,
                    MONGO_ARCHIVE,
                    '-C',
                    path.dirname(this.cfg.uploadsDir),
                    uploadsBase,
                ],
                {
                    out: partial,
                    accepted: tarAccepted,
                    // macOS tar otherwise stores file metadata as extra "._*" entries
                    env: { COPYFILE_DISABLE: '1' },
                },
            );
            const { size } = await stat(partial);
            if (size === 0) throw new Error('The archive is empty');
            await rename(partial, target);
            await chmod(target, 0o600);
            const now = new Date();
            await this.backups.updateOne(
                { _id: id },
                {
                    status: 'success',
                    finished_at: now,
                    file_name: fileName,
                    size_bytes: size,
                    contents: {
                        db_name: manifest.db.name,
                        collections: collections.length,
                        db_bytes: manifest.db.bytes,
                        uploads_files: uploads.files,
                        uploads_bytes: uploads.bytes,
                        based_on: manifest.based_on,
                        app_version: manifest.app_version,
                        db_version: manifest.db.version ?? null,
                    },
                },
            );
            return null;
        } catch (error) {
            const message = redact(
                error instanceof Error ? error.message : String(error),
            );
            await this.backups
                .updateOne(
                    { _id: id },
                    {
                        status: 'failed',
                        finished_at: new Date(),
                        error: message,
                    },
                )
                .catch((e) => console.error('backup status not saved', e));
            return message;
        } finally {
            await rm(conf, { force: true });
            await rm(work, { recursive: true, force: true });
            await rm(partial, { force: true });
        }
    }

    private async collectionNames(): Promise<string[]> {
        const db = this.connection.db;
        if (!db) return [];
        const list = await db.listCollections({}, { nameOnly: true }).toArray();
        return list
            .map((item) => item.name)
            .filter((name) => !name.startsWith('system.'))
            .sort();
    }

    async prune(): Promise<number> {
        const now = new Date();
        const daily = await this.backups
            .find({
                status: 'success',
                kind: { $nin: ['pre_restore', 'uploaded'] },
            })
            .select('started_at file_name file_removed_at')
            .lean();
        const expired = expiredBackups(
            daily.map((item) => ({
                id: String(item._id),
                startedAt: item.started_at,
            })),
            now,
            this.cfg,
        );
        let removed = 0;
        for (const item of daily) {
            if (
                !expired.has(String(item._id)) ||
                !item.file_name ||
                item.file_removed_at
            ) {
                continue;
            }
            await rm(this.resolve(item.file_name), { force: true });
            await this.backups.updateOne(
                { _id: item._id },
                { file_removed_at: now, file_removed_reason: 'rotation' },
            );
            removed += 1;
        }

        const limits: [Backup['kind'], number][] = [
            ['pre_restore', this.cfg.keepPreRestore],
            ['uploaded', this.cfg.keepUploaded],
        ];
        for (const [kind, keep] of limits) {
            const kept = (
                await this.backups
                    .find({ status: 'success', kind, file_removed_at: null })
                    .select('started_at file_name')
                    .lean()
            ).sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
            for (const item of kept.slice(keep)) {
                if (item.file_name) {
                    await rm(this.resolve(item.file_name), { force: true });
                }
                await this.backups.updateOne(
                    { _id: item._id },
                    { file_removed_at: now, file_removed_reason: 'rotation' },
                );
                removed += 1;
            }
        }
        return removed;
    }

    async discardSnapshot(id: string) {
        const record = await this.findRecord(id);
        if (
            !record ||
            record.kind !== 'pre_restore' ||
            record.file_removed_at
        ) {
            return;
        }
        if (record.file_name) {
            await rm(this.resolve(record.file_name), { force: true });
        }
        await this.backups.updateOne(
            { _id: record._id },
            { file_removed_at: new Date(), file_removed_reason: 'restored' },
        );
    }

    private async removeLeftovers() {
        for (const name of await readdir(this.cfg.dir)) {
            if (
                name.startsWith('.work-') ||
                name.startsWith('.restore-') ||
                name.startsWith('.uri.') ||
                name.endsWith('.partial')
            ) {
                await rm(this.resolve(name), { recursive: true, force: true });
            }
        }
    }

    private resolve(name: string): string {
        const target = path.resolve(this.cfg.dir, name);
        if (path.dirname(target) !== this.cfg.dir) {
            throw new Error(`Backup file escapes backups dir: ${name}`);
        }
        return target;
    }
}

class NotFound extends NotFoundException {
    constructor() {
        super('Backup file not found');
    }
}
