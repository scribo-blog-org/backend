import { ConfigService } from '@nestjs/config';
import path from 'path';
import {
    backupsConfig,
    msUntilNextRun,
    parseTimeOfDay,
    expiredDays,
    tarAccepted,
    utcDay,
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

describe('expiredDays', () => {
    const cfg = { keepDailyDays: 7, keepMonths: 12 };
    const now = new Date('2026-10-12T05:00:00Z');

    it('keeps every day of the last week', () => {
        const days = [
            '2026-10-12',
            '2026-10-11',
            '2026-10-09',
            '2026-10-06',
            '2026-10-05',
        ];
        expect(expiredDays(days, now, cfg).size).toBe(0);
    });

    it('drops older days except the first backup of each month', () => {
        const days = [
            '2026-10-02', // первая копия октября, старше недели: остаётся
            '2026-10-03', // старше недели, не первая: уходит
            '2026-10-05', // 7 суток назад: остаётся
            '2026-09-01', // первая сентября
            '2026-09-15',
            '2026-09-30',
        ];
        expect(expiredDays(days, now, cfg)).toEqual(
            new Set(['2026-10-03', '2026-09-15', '2026-09-30']),
        );
    });

    it('treats the first backup of a month as the earliest one, not the 1st', () => {
        const days = ['2026-08-05', '2026-08-06', '2026-08-20'];
        expect(expiredDays(days, now, cfg)).toEqual(
            new Set(['2026-08-06', '2026-08-20']),
        );
    });

    it('drops monthly copies older than keepMonths', () => {
        const days = ['2025-09-01', '2025-10-01', '2025-11-01'];
        // октябрь 2026 минус 13 месяцев = сентябрь 2025
        expect(expiredDays(days, now, cfg)).toEqual(new Set(['2025-09-01']));
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
