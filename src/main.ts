import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertSetup } from './config/startup';
import { LoggerService } from './infra/logger.service';
import { NestRuntimeLogger, installProcessHandlers, rlog } from './infra/rlog';
import { StartupService } from './infra/startup.service';
import { buildInfo } from './infra/build-info';
import { DbVersionService } from './modules/backups/db-version.service';
import { appVersion } from './modules/backups/manifest';
import { configureScriboApp } from './create-app';

async function bootstrap() {
    try {
        installProcessHandlers();
        assertSetup(process.env);

        const app = await NestFactory.create(AppModule, {
            abortOnError: true,
            logger: new NestRuntimeLogger(),
        });
        const startup = app.get(StartupService);
        await startup.assertDatabase();
        await startup.assertFiles();

        await configureScriboApp(app);
        const port = process.env.PORT ?? '3001';
        await app.listen(port, '0.0.0.0');
        const migration = app.get(DbVersionService).migration;
        rlog.info('backend ready', {
            port: Number(port),
            version: appVersion(),
            ...buildInfo(),
            node: process.version,
            env: process.env.NODE_ENV ?? 'development',
            migration: migration.status,
            log_dir: process.env.LOG_DIR ?? null,
        });
        await app
            .get(LoggerService)
            .system('server_start', `Server started on port ${port}`, {
                version: appVersion(),
                ...buildInfo(),
                node: process.version,
                env: process.env.NODE_ENV ?? 'development',
                port: Number(port),
                migration: migration.status,
                migration_from: migration.from_version,
                migration_to: migration.to_version,
            });
    } catch (error) {
        rlog.error('backend failed to start', { error });
        setTimeout(() => process.exit(1), 100);
    }
}

void bootstrap();
