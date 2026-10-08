import { DbVersionService } from './db-version.service';
import {
    dbVersionOf,
    incompatibility,
    readDbMeta,
    syncDbMeta,
} from './db-version';
import { fakeConnection, fakeLogger } from './backups.test-utils';
import { appVersion } from './manifest';

describe('database version', () => {
    it('is the major and minor of the backend version', () => {
        expect(dbVersionOf('7.1.2')).toBe('7.1');
        expect(dbVersionOf('7.1.0')).toBe('7.1');
        expect(dbVersionOf('7.10.3')).toBe('7.10');
        expect(dbVersionOf('7.1')).toBe('7.1');
        expect(dbVersionOf('unknown')).toBeNull();
        expect(dbVersionOf(undefined)).toBeNull();
    });

    it('treats a patch bump as compatible and a minor bump as not', () => {
        const current = dbVersionOf('7.1.2');
        expect(incompatibility(dbVersionOf('7.1.1'), current)).toBeNull();
        expect(incompatibility(dbVersionOf('7.2.0'), current)).toMatch(
            /data version 7\.2, this system works with 7\.1/,
        );
        expect(incompatibility(null, current)).toMatch(/version unknown/);
        expect(incompatibility('7.1', null)).toMatch(/cannot be checked/);
    });

    it('writes the version into the database and keeps it in step', async () => {
        const connection = fakeConnection();
        expect(await readDbMeta(connection as any)).toBeNull();

        const first = await syncDbMeta(connection as any, '7.1.1');
        expect(first.previous).toBeNull();
        expect(connection.meta.get('db')).toMatchObject({
            version: '7.1',
            app_version: '7.1.1',
        });
        expect(connection.meta.get('db')!.created_at).toBeInstanceOf(Date);

        const second = await syncDbMeta(connection as any, '7.1.2');
        expect(second.previous).toMatchObject({ app_version: '7.1.1' });
        expect(connection.meta.get('db')).toMatchObject({
            version: '7.1',
            app_version: '7.1.2',
        });
    });

    describe('on start', () => {
        it('syncs and reports a change once', async () => {
            const connection = fakeConnection();
            const logger = fakeLogger();
            const service = new DbVersionService(
                connection as any,
                logger as any,
            );

            await service.onModuleInit();
            expect(logger.system).toHaveBeenCalledWith(
                'db_version_sync',
                expect.stringContaining(`backend ${appVersion()}`),
                expect.objectContaining({
                    from_version: null,
                    to_version: dbVersionOf(appVersion()),
                }),
            );

            await service.onModuleInit();
            expect(logger.system).toHaveBeenCalledTimes(1);
        });

        it('stops the server and logs an error when the write fails', async () => {
            const connection = fakeConnection();
            connection.db.collection = () => {
                throw new Error('mongo down');
            };
            const spy = jest.spyOn(console, 'error').mockImplementation();
            const logger = fakeLogger();
            const service = new DbVersionService(
                connection as any,
                logger as any,
            );
            await expect(service.onModuleInit()).rejects.toThrow('mongo down');
            expect(logger.system).toHaveBeenCalledWith(
                'db_version_failed',
                expect.any(String),
                { error: 'mongo down' },
                'error',
            );
            spy.mockRestore();
        });
    });
});
