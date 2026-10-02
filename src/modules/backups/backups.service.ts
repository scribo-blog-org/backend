import {
    ConflictException,
    Injectable,
    NotFoundException,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import { createReadStream, createWriteStream } from 'fs';
import {
    chmod,
    mkdir,
    readdir,
    rename,
    rm,
    stat,
    writeFile,
} from 'fs/promises';
import { Model, Types } from 'mongoose';
import path from 'path';
import { pipeline } from 'stream/promises';
import { mongoUri } from '../../config/startup';
import {
    Backup,
    type BackupTrigger,
} from '../../database/schemas/backup.schema';
import { paginationMeta, parsePagination } from '../../http/pagination';
import {
    backupsConfig,
    expiredDays,
    msUntilNextRun,
    tarAccepted,
    utcDay,
    type BackupsConfig,
} from './backups.config';

const DUMP_TIMEOUT_MS = 30 * 60 * 1000;
const STDERR_TAIL = 1500;
// setTimeout не принимает задержку больше 2^31 мс; сутки с запасом влезают.
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Бекап в один файл `scribo-ГГГГ-ММ-ДД.tar`: дамп Mongo и каталог загрузок.
 * Запускается по расписанию и по кнопке из админки. Файл называется по дню
 * (UTC), поэтому повторный запуск в тот же день перезаписывает сегодняшний
 * бекап, а в новый день создаёт новый.
 */
@Injectable()
export class BackupsService implements OnModuleInit, OnModuleDestroy {
    private readonly cfg: BackupsConfig;
    private readonly uri: () => string;
    private timer: NodeJS.Timeout | null = null;
    private running = false;

    constructor(
        config: ConfigService,
        @InjectModel(Backup.name) private readonly backups: Model<Backup>,
    ) {
        this.cfg = backupsConfig(config);
        this.uri = () => mongoUri(config);
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

    status() {
        const { hour, minute } = this.cfg.at;
        const pad = (n: number) => String(n).padStart(2, '0');
        return {
            enabled: this.cfg.enabled,
            running: this.running,
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
            items: items.map((item) => ({
                ...item,
                can_download:
                    item.status === 'success' &&
                    Boolean(item.file_name) &&
                    !item.file_removed_at,
            })),
            pagination: paginationMeta(page, limit, total),
        };
    }

    async start(trigger: BackupTrigger, userId?: string) {
        if (!this.cfg.enabled) {
            throw new ConflictException('Backups are disabled');
        }
        if (this.running) {
            throw new ConflictException('A backup is already running');
        }
        this.running = true;
        let record;
        try {
            const startedAt = new Date();
            record = await this.backups.create({
                day: utcDay(startedAt),
                trigger,
                triggered_by: userId ? new Types.ObjectId(userId) : null,
                status: 'running',
                started_at: startedAt,
            });
        } catch (error) {
            this.running = false;
            throw error;
        }
        void this.execute(record._id, record.day);
        return record.toObject();
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

    private async execute(id: Types.ObjectId, day: string) {
        const fileName = `scribo-${day}.tar`;
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
            await this.runToFile(
                this.cfg.mongodump,
                [
                    `--config=${conf}`,
                    '--gzip',
                    '--archive',
                    '--numParallelCollections=1',
                ],
                path.join(work, 'mongo.archive.gz'),
                (code) => code === 0,
            );
            await mkdir(this.cfg.uploadsDir, { recursive: true });
            await this.runToFile(
                this.cfg.tar,
                [
                    '-cf',
                    '-',
                    '-C',
                    work,
                    'mongo.archive.gz',
                    '-C',
                    path.dirname(this.cfg.uploadsDir),
                    path.basename(this.cfg.uploadsDir),
                ],
                partial,
                tarAccepted,
            );
            const { size } = await stat(partial);
            if (size === 0) throw new Error('The archive is empty');
            // rename заменяет файл за этот день целиком и сразу: пока дамп
            // не готов, прежний бекап дня остаётся на месте.
            await rename(partial, target);
            await chmod(target, 0o600);
            const now = new Date();
            await this.backups.updateMany(
                {
                    day,
                    status: 'success',
                    _id: { $ne: id },
                    file_removed_at: null,
                },
                { file_removed_at: now, file_removed_reason: 'replaced' },
            );
            await this.backups.updateOne(
                { _id: id },
                {
                    status: 'success',
                    finished_at: now,
                    file_name: fileName,
                    size_bytes: size,
                },
            );
        } catch (error) {
            await this.backups
                .updateOne(
                    { _id: id },
                    {
                        status: 'failed',
                        finished_at: new Date(),
                        error: redact(
                            error instanceof Error
                                ? error.message
                                : String(error),
                        ),
                    },
                )
                .catch((e) => console.error('backup status not saved', e));
        } finally {
            await rm(conf, { force: true });
            await rm(work, { recursive: true, force: true });
            await rm(partial, { force: true });
            this.running = false;
        }
        await this.prune().catch((e) =>
            console.error('backup prune failed', e),
        );
    }

    /** Запускает программу, складывает её stdout в файл, ждёт завершения. */
    private async runToFile(
        command: string,
        args: string[],
        out: string,
        accepted: (code: number | null, stderr: string) => boolean,
    ) {
        const child = spawn(command, args, {
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let tail = '';
        child.stderr.on('data', (chunk: Buffer) => {
            tail = (tail + chunk.toString()).slice(-STDERR_TAIL);
        });
        const killer = setTimeout(() => child.kill('SIGKILL'), DUMP_TIMEOUT_MS);
        const name = path.basename(command);
        const exited = new Promise<void>((resolve, reject) => {
            child.on('error', (error: NodeJS.ErrnoException) =>
                reject(
                    error.code === 'ENOENT'
                        ? new Error(`${name} is not installed`)
                        : error,
                ),
            );
            child.on('close', (code, signal) =>
                accepted(code, tail)
                    ? resolve()
                    : reject(
                          new Error(
                              `${name} exited with ${signal ?? `code ${code}`}: ${tail.trim()}`,
                          ),
                      ),
            );
        });
        try {
            await Promise.all([
                pipeline(child.stdout, createWriteStream(out, { mode: 0o600 })),
                exited,
            ]);
        } finally {
            clearTimeout(killer);
        }
    }

    private async prune() {
        const now = new Date();
        const successes = await this.backups
            .find({ status: 'success' })
            .select('day file_name file_removed_at')
            .lean();
        const expired = expiredDays(
            [...new Set(successes.map((item) => item.day))],
            now,
            this.cfg,
        );
        for (const item of successes) {
            if (
                !expired.has(item.day) ||
                !item.file_name ||
                item.file_removed_at
            ) {
                continue;
            }
            await rm(this.resolve(item.file_name), { force: true });
            await this.backups.updateMany(
                { day: item.day, file_removed_at: null, status: 'success' },
                { file_removed_at: now, file_removed_reason: 'rotation' },
            );
        }
    }

    /** Остатки от процесса, который упал посреди бекапа. */
    private async removeLeftovers() {
        for (const name of await readdir(this.cfg.dir)) {
            if (
                name.startsWith('.work-') ||
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

function redact(message: string) {
    return message.replace(/mongodb(\+srv)?:\/\/[^\s]*@/g, 'mongodb$1://***@');
}
