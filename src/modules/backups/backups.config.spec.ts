import { ConfigService } from '@nestjs/config';
import path from 'path';
import {
    backupsConfig,
    msUntilNextRun,
    parseTimeOfDay,
    expiredBackups,
    tarAccepted,
    utcDay,
    uriWithoutDb,
} from './backups.config';

const env = (values: Record<string, string>) =>
    new ConfigService(values) as unknown as ConfigService;

describe('backupsConfig', () => {
    it('is disabled unless BACKUP_ENABLED is exactly true', () => {
        expect(backupsConfig(env({})).enabled).toBe(false);
        expect(backupsConfig(env({ BACKUP_ENABLED: 'yes' })).enabled).toBe(
            false,
        );
        expect(backupsConfig(env({ BACKUP_ENABLED: 'true' })).enabled).toBe(
            true,
        );
    });

    it('falls back to defaults on bad values', () => {
        const cfg = backupsConfig(
            env({
                BACKUP_AT: '25:99',
                BACKUP_KEEP_DAILY_DAYS: '-3',
                BACKUPS_DIR: '/data/backups',
            }),
        );
        expect(cfg.at).toEqual({ hour: 4, minute: 15 });
        expect(cfg.keepDailyDays).toBe(7);
        expect(cfg.keepMonths).toBe(12);
        expect(cfg.dir).toBe(path.resolve('/data/backups'));
    });
});

describe('parseTimeOfDay', () => {
    it('parses HH:MM', () => {
        expect(parseTimeOfDay('3:05')).toEqual({ hour: 3, minute: 5 });
        expect(parseTimeOfDay('abc')).toBeNull();
        expect(parseTimeOfDay(undefined)).toBeNull();
    });
});

describe('msUntilNextRun', () => {
    const at = { hour: 4, minute: 15 };

    it('runs later today when the slot has not passed', () => {
        const now = new Date('2026-10-02T03:15:00Z');
        expect(msUntilNextRun(at, now)).toBe(60 * 60 * 1000);
    });

    it('rolls to tomorrow when the slot has passed or is now', () => {
        const day = 24 * 60 * 60 * 1000;
        expect(msUntilNextRun(at, new Date('2026-10-02T04:15:00Z'))).toBe(day);
        expect(msUntilNextRun(at, new Date('2026-10-02T05:15:00Z'))).toBe(
            day - 60 * 60 * 1000,
        );
    });
});

describe('utcDay', () => {
    it('uses the UTC calendar day', () => {
        expect(utcDay(new Date('2026-10-02T23:59:59Z'))).toBe('2026-10-02');
        expect(utcDay(new Date('2026-10-03T00:00:00Z'))).toBe('2026-10-03');
    });
});

describe('expiredBackups', () => {
    const cfg = { keepDailyDays: 7, keepMonths: 12 };
    // Понедельник.
    const now = new Date('2026-10-12T05:00:00Z');
    const at = (id: string, iso: string) => ({
        id,
        startedAt: new Date(iso),
    });

    it('keeps every backup made today, manual ones included', () => {
        const items = [
            at('a', '2026-10-12T03:00:00Z'),
            at('b', '2026-10-12T04:15:00Z'),
            at('c', '2026-10-12T04:59:00Z'),
        ];
        expect(expiredBackups(items, now, cfg).size).toBe(0);
    });

    it('leaves one backup per past day, the last one', () => {
        const items = [
            at('early', '2026-10-10T04:15:00Z'),
            at('late', '2026-10-10T20:00:00Z'),
            at('only', '2026-10-06T04:15:00Z'),
        ];
        expect(expiredBackups(items, now, cfg)).toEqual(new Set(['early']));
    });

    it('keeps the day that is exactly keepDailyDays old, not older ones', () => {
        const items = [
            at('seven', '2026-10-05T04:15:00Z'), // 7 суток назад
            at('eight', '2026-10-04T04:15:00Z'), // воскресенье, но старше недели
            at('nine', '2026-10-03T04:15:00Z'),
        ];
        // Воскресенье ничем не лучше других дней: старше недели остаются только месячные.
        expect(expiredBackups(items, now, cfg)).toEqual(
            new Set(['eight', 'nine']),
        );
    });

    it('keeps the last backup of each month, which is the last day', () => {
        const items = [
            at('sep29', '2026-09-29T04:15:00Z'),
            at('sep30', '2026-09-30T04:15:00Z'), // последний день месяца
            at('sep20', '2026-09-20T04:15:00Z'), // воскресенье
            at('aug30', '2026-08-30T04:15:00Z'),
            at('aug31', '2026-08-31T04:15:00Z'), // последний день месяца
        ];
        expect(expiredBackups(items, now, cfg)).toEqual(
            new Set(['sep29', 'sep20', 'aug30']),
        );
    });

    it('falls back to the last backup of a month when its last day has none', () => {
        const items = [
            at('aug20', '2026-08-20T04:15:00Z'),
            at('aug28', '2026-08-28T04:15:00Z'),
        ];
        expect(expiredBackups(items, now, cfg)).toEqual(new Set(['aug20']));
    });

    it('drops monthly copies older than keepMonths', () => {
        const items = [
            at('recent', '2025-11-30T04:15:00Z'), // 11 месяцев назад
            at('edge', '2025-10-31T04:15:00Z'), // ровно 12
            at('old', '2025-09-30T04:15:00Z'), // 13
        ];
        expect(expiredBackups(items, now, cfg)).toEqual(new Set(['old']));
    });

    it('decides by the whole history, so a removed last backup is not replaced by the one before it', () => {
        // Файл 'late' уже удалён, но запись в истории есть: 'early' по-прежнему не последний.
        const items = [
            at('early', '2026-10-09T04:15:00Z'),
            at('late', '2026-10-09T20:00:00Z'),
        ];
        expect(expiredBackups(items, now, cfg)).toEqual(new Set(['early']));
    });
});

describe('tarAccepted', () => {
    it('accepts success and warnings about files changing mid-read', () => {
        expect(tarAccepted(0, '')).toBe(true);
        expect(
            tarAccepted(1, 'tar: uploads/a.png: file changed as we read it\n'),
        ).toBe(true);
    });

    it('rejects real errors', () => {
        expect(tarAccepted(2, '')).toBe(false);
        expect(
            tarAccepted(1, 'tar: uploads: Cannot open: Permission denied'),
        ).toBe(false);
        expect(tarAccepted(1, '')).toBe(false);
        expect(tarAccepted(null, '')).toBe(false);
    });
});

describe('uriWithoutDb', () => {
    it('drops only the database from the path', () => {
        expect(
            uriWithoutDb(
                'mongodb+srv://u:p@h.net/prod?retryWrites=true&w=majority',
            ),
        ).toBe('mongodb+srv://u:p@h.net/?retryWrites=true&w=majority');
        expect(
            uriWithoutDb(
                'mongodb://u:p@127.0.0.1:27017/scribo?authSource=admin',
            ),
        ).toBe('mongodb://u:p@127.0.0.1:27017/?authSource=admin');
        expect(uriWithoutDb('mongodb+srv://u:p@h.net/prod')).toBe(
            'mongodb+srv://u:p@h.net/',
        );
        expect(uriWithoutDb('mongodb://a:1,b:2/db?x=1')).toBe(
            'mongodb://a:1,b:2/?x=1',
        );
    });
});
