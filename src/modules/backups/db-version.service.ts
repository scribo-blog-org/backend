import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { LoggerService } from '../../infra/logger.service';
import { syncDbMeta } from './db-version';
import { appVersion } from './manifest';

/**
 * При каждом запуске приводит запись о версии в базе к версии backend. Работает
 * независимо от того, включены ли бекапы: версия нужна и для того, чтобы
 * архивы, снятые потом, были подписаны правильно.
 */
@Injectable()
export class DbVersionService implements OnModuleInit {
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
                return;
            }
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
            // Запись о версии не повод не стартовать: бекапы просто подпишутся по коду.
            console.error('database version was not synced', error);
        }
    }
}
