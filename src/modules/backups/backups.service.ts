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
import { readState } from './backups.state';
import {
    MANIFEST_FILE,
    MANIFEST_VERSION,
    MONGO_ARCHIVE,
    appVersion,
    dirStats,
    sha256File,
    type BackupKind,
    type Manifest,
} from './manifest';
import { runProcess } from './run-process';

// setTimeout не принимает задержку больше 2^31 мс; сутки с запасом влезают.
const MAX_TIMER_MS = 2 ** 31 - 1;

type Busy = 'backup' | 'restore' | null;

/**
 * Бекап в один файл: дамп Mongo, каталог загрузок и manifest.json, который
 * их связывает. Запускается по расписанию и по кнопке из админки. Каждый
 * запуск это новый файл со временем в имени. Правила хранения (за сегодня все,
 * за прошлые дни один, дальше по одному на месяц) применяет
 * prune после каждого бекапа. Страховочный снимок перед откатом живёт
 * отдельно: хранятся последние несколько.
 */
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
        // Процесс мог упасть посреди дампа: такая запись навсегда осталась бы running.
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

    /** Один процесс занят одним делом: бекапом или откатом. */
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
        };
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
                return {
                    ...item,
                    can_download: hasFile,
                    can_restore:
                        this.cfg.restoreEnabled &&
                        hasFile &&
                        Boolean(item.contents),
                };
            }),
            pagination: paginationMeta(page, limit, total),
        };
    }

    async start(trigger: BackupTrigger, userId?: string) {
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
        void this.runAndRelease(record._id, record.day, trigger);
        return record.toObject();
    }

    /**
     * Страховочный снимок перед откатом. Зовётся из отката, который уже держит
     * блокировку, поэтому сам её не берёт. Бросает, если снять не удалось.
     */
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
            // Отсчёт от «через минуту»: таймер может сработать на миллисекунды
            // раньше срока и тогда запустил бы тот же слот второй раз.
            this.scheduleNext(new Date(Date.now() + 60_000));
        }, delay);
        // Таймер не должен удерживать процесс при остановке.
        this.timer.unref();
    }

    private async runAndRelease(
        id: Types.ObjectId,
        day: string,
        trigger: BackupTrigger,
    ) {
        try {
            await this.produce(id, day, 'daily', trigger);
            await this.prune().catch((e) =>
                console.error('backup prune failed', e),
            );
        } finally {
            this.release();
        }
    }

    /**
     * Собирает архив и обновляет запись. Возвращает текст ошибки или null.
     * Исключения наружу не выпускает: итог всегда оказывается в записи.
     */
    private async produce(
        id: Types.ObjectId,
        day: string,
        kind: BackupKind,
        trigger: Manifest['trigger'],
    ): Promise<string | null> {
        const stamp = new Date()
            .toISOString()
            .replace(/[-:]/g, '')
            .replace(/\..*/, '')
            .replace('T', '-');
        // Каждый бекап отдельный файл: ручной не заменяет ни вчерашний,
        // ни сегодняшний, а добавляется. Лишнее убирает prune.
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
            // URI с паролем идёт через файл 0600, а не аргументом: в списке
            // процессов и в логах его нет.
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
                { out: partial, accepted: tarAccepted },
            );
            const { size } = await stat(partial);
            if (size === 0) throw new Error('The archive is empty');
            // rename заменяет файл за этот день целиком и сразу: пока архив
            // не готов, прежний бекап дня остаётся на месте.
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

    private async prune() {
        const now = new Date();
        const daily = await this.backups
            .find({ status: 'success', kind: { $ne: 'pre_restore' } })
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
        }

        // Страховочные снимки: последние keepPreRestore, остальные удаляем.
        const snapshots = (
            await this.backups
                .find({
                    status: 'success',
                    kind: 'pre_restore',
                    file_removed_at: null,
                })
                .select('started_at file_name')
                .lean()
        ).sort((a, b) => b.started_at.getTime() - a.started_at.getTime());
        for (const item of snapshots.slice(this.cfg.keepPreRestore)) {
            if (item.file_name) {
                await rm(this.resolve(item.file_name), { force: true });
            }
            await this.backups.updateOne(
                { _id: item._id },
                { file_removed_at: now, file_removed_reason: 'rotation' },
            );
        }
    }

    /** Остатки от процесса, который упал посреди бекапа или отката. */
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
