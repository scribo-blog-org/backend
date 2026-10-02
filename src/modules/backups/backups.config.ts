import type { ConfigService } from '@nestjs/config';
import path from 'path';
import { uploadsDir } from '../../files/files.config';

type Env = Pick<ConfigService, 'get'>;

export type BackupsConfig = {
    enabled: boolean;
    /** Откат из админки. Включается отдельно от самих бекапов. */
    restoreEnabled: boolean;
    dir: string;
    mongodump: string;
    mongorestore: string;
    /** Время ежедневного запуска по UTC, часы и минуты. */
    at: { hour: number; minute: number };
    /** Сколько последних суток хранить по бекапу на день (за сегодня все). */
    keepDailyDays: number;
    /** Сколько месяцев назад хранить по одной копии на месяц. */
    keepMonths: number;
    /** Сколько страховочных снимков перед откатом хранить. */
    keepPreRestore: number;
    uploadsDir: string;
    tar: string;
};

const DEFAULT_AT = '04:15';

export function parseTimeOfDay(value: string | undefined) {
    const match = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
    const hour = match ? Number(match[1]) : NaN;
    const minute = match ? Number(match[2]) : NaN;
    if (!match || hour > 23 || minute > 59) return null;
    return { hour, minute };
}

function positiveInt(value: string | undefined, fallback: number) {
    const parsed = Number.parseInt(value ?? '', 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function backupsConfig(config: Env): BackupsConfig {
    const at = config.get<string>('BACKUP_AT');
    const dir = config.get<string>('BACKUPS_DIR')?.trim();
    const enabled = config.get<string>('BACKUP_ENABLED')?.trim() === 'true';
    return {
        enabled,
        restoreEnabled:
            enabled &&
            config.get<string>('BACKUP_RESTORE_ENABLED')?.trim() === 'true',
        dir: path.resolve(dir || path.join(process.cwd(), 'backups')),
        mongodump: config.get<string>('MONGODUMP_BIN')?.trim() || 'mongodump',
        mongorestore:
            config.get<string>('MONGORESTORE_BIN')?.trim() || 'mongorestore',
        at: parseTimeOfDay(at) ?? parseTimeOfDay(DEFAULT_AT)!,
        keepDailyDays: positiveInt(
            config.get<string>('BACKUP_KEEP_DAILY_DAYS'),
            7,
        ),
        keepMonths: positiveInt(config.get<string>('BACKUP_KEEP_MONTHS'), 12),
        keepPreRestore: positiveInt(
            config.get<string>('BACKUP_KEEP_PRE_RESTORE'),
            3,
        ),
        uploadsDir: uploadsDir(config),
        tar: config.get<string>('TAR_BIN')?.trim() || 'tar',
    };
}

/** Миллисекунды до ближайшего ежедневного запуска по UTC. */
export function msUntilNextRun(
    at: { hour: number; minute: number },
    now: Date,
): number {
    const next = new Date(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            at.hour,
            at.minute,
        ),
    );
    if (next.getTime() <= now.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
    }
    return next.getTime() - now.getTime();
}

/** Календарный день по UTC в виде ГГГГ-ММ-ДД. По нему называется файл. */
export function utcDay(date: Date): string {
    return date.toISOString().slice(0, 10);
}

function dayNumber(day: string): number {
    return Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
}

function monthNumber(day: string): number {
    return Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
}

export type BackupStamp = { id: string; startedAt: Date };

/**
 * Какие бекапы больше не нужны. Все бекапы сегодняшнего дня (по UTC), в том
 * числе ручные, остаются. За последние `keepDailyDays` суток остаётся один
 * бекап на день, последний за день. Дальше остаётся один на месяц, последний
 * за месяц, то есть последнего дня, до `keepMonths` месяцев назад.
 *
 * `items` — все успешные бекапы, включая те, чей файл уже удалён: «последний
 * за день и за месяц» должен считаться по полной истории, иначе после
 * удаления «последнего» его роль перешла бы к предпоследнему.
 */
export function expiredBackups(
    items: BackupStamp[],
    now: Date,
    cfg: Pick<BackupsConfig, 'keepDailyDays' | 'keepMonths'>,
): Set<string> {
    const today = utcDay(now);
    const lastOf = (key: (day: string) => number) => {
        const latest = new Map<number, BackupStamp>();
        for (const item of items) {
            const k = key(utcDay(item.startedAt));
            const known = latest.get(k);
            if (!known || item.startedAt > known.startedAt) latest.set(k, item);
        }
        return latest;
    };
    const lastOfDay = lastOf(dayNumber);
    const lastOfMonth = lastOf(monthNumber);

    const expired = new Set<string>();
    for (const item of items) {
        const day = utcDay(item.startedAt);
        if (day === today) continue;
        if (
            lastOfDay.get(dayNumber(day))?.id === item.id &&
            dayNumber(today) - dayNumber(day) <= cfg.keepDailyDays
        ) {
            continue;
        }
        if (
            lastOfMonth.get(monthNumber(day))?.id === item.id &&
            monthNumber(today) - monthNumber(day) <= cfg.keepMonths
        ) {
            continue;
        }
        expired.add(item.id);
    }
    return expired;
}

/** tar вернул 1, потому что файл менялся во время чтения: архив при этом годный. */
export function tarAccepted(code: number | null, stderr: string): boolean {
    if (code === 0) return true;
    if (code !== 1) return false;
    const lines = stderr
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    return (
        lines.length > 0 &&
        lines.every((line) =>
            /file changed as we read it|file removed before we read it/i.test(
                line,
            ),
        )
    );
}

/** Строка подключения без имени базы: mongorestore берёт базу из --nsInclude. */
export function uriWithoutDb(uri: string): string {
    return uri.replace(/^(mongodb(?:\+srv)?:\/\/[^/?]+)\/[^?]*/, '$1/');
}

export function redact(message: string): string {
    return message.replace(/mongodb(\+srv)?:\/\/[^\s]*@/g, 'mongodb$1://***@');
}
