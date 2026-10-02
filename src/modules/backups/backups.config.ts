import type { ConfigService } from '@nestjs/config';
import path from 'path';
import { uploadsDir } from '../../files/files.config';

type Env = Pick<ConfigService, 'get'>;

export type BackupsConfig = {
    enabled: boolean;
    dir: string;
    mongodump: string;
    /** Время ежедневного запуска по UTC, часы и минуты. */
    at: { hour: number; minute: number };
    /** Сколько последних суток хранить каждый день. */
    keepDailyDays: number;
    /** Сколько месяцев назад хранить по одной копии на месяц. */
    keepMonths: number;
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
    return {
        enabled: config.get<string>('BACKUP_ENABLED')?.trim() === 'true',
        dir: path.resolve(dir || path.join(process.cwd(), 'backups')),
        mongodump: config.get<string>('MONGODUMP_BIN')?.trim() || 'mongodump',
        at: parseTimeOfDay(at) ?? parseTimeOfDay(DEFAULT_AT)!,
        keepDailyDays: positiveInt(
            config.get<string>('BACKUP_KEEP_DAILY_DAYS'),
            7,
        ),
        keepMonths: positiveInt(config.get<string>('BACKUP_KEEP_MONTHS'), 12),
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

/**
 * Какие дни больше не нужны. Хранится каждый день за последние `keepDailyDays`
 * суток, а дальше по одной копии на месяц: самая ранняя копия месяца живёт
 * до `keepMonths` месяцев назад. `days` — все дни, за которые был успешный
 * бекап, включая те, чей файл уже удалён: иначе после удаления «первой
 * копии месяца» роль перешла бы к следующей и она бы тоже осталась.
 */
export function expiredDays(
    days: string[],
    now: Date,
    cfg: Pick<BackupsConfig, 'keepDailyDays' | 'keepMonths'>,
): Set<string> {
    const today = dayNumber(utcDay(now));
    const thisMonth = monthNumber(utcDay(now));
    const firstOfMonth = new Map<number, string>();
    for (const day of days) {
        const month = monthNumber(day);
        const known = firstOfMonth.get(month);
        if (!known || day < known) firstOfMonth.set(month, day);
    }
    const expired = new Set<string>();
    for (const day of days) {
        if (today - dayNumber(day) <= cfg.keepDailyDays) continue;
        const month = monthNumber(day);
        if (
            firstOfMonth.get(month) === day &&
            thisMonth - month <= cfg.keepMonths
        ) {
            continue;
        }
        expired.add(day);
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
