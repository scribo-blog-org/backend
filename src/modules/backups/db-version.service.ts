import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { LoggerService } from '../../infra/logger.service';
import { syncDbMeta } from './db-version';
import { appVersion } from './manifest';

export type DbMigrationResult = {
    status: 'unchanged' | 'synced' | 'pending';
    from_version: string | null;
    to_version: string | null;
};

@Injectable()
export class DbVersionService implements OnModuleInit {
    migration: DbMigrationResult = {
        status: 'pending',
        from_version: null,
        to_version: null,
    };

    constructor(
        @InjectConnection() private readonly connection: Connection,
        private readonly logger: LoggerService,
    ) {}

    async onModuleInit() {
        try {
            const { previous, current } = await syncDbMeta(
                this.connection,
                appVersion(),
            );
            if (
                previous?.app_version === current.app_version &&
                previous.version === current.version
            ) {
                this.migration = {
                    status: 'unchanged',
                    from_version: current.version,
                    to_version: current.version,
                };
                return;
            }
            this.migration = {
                status: 'synced',
                from_version: previous?.version ?? null,
                to_version: current.version,
            };
            await this.logger.system(
                'db_version_sync',
                `Database version ${previous?.version ?? 'none'} → ${current.version ?? 'unknown'} (backend ${current.app_version})`,
                {
                    from_version: previous?.version ?? null,
                    to_version: current.version,
                    from_app_version: previous?.app_version ?? null,
                    app_version: current.app_version,
                },
            );
        } catch (error) {
            console.error('database version was not synced', error);
            await this.logger.system(
                'db_version_failed',
                'Database version was not synced',
                {
                    error:
                        error instanceof Error ? error.message : String(error),
                },
                'error',
            );
            throw error;
        }
    }
}
