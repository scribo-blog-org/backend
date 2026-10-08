import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertSetup } from './config/startup';
import { LoggerService } from './infra/logger.service';
import { StartupService } from './infra/startup.service';
import { buildInfo } from './infra/build-info';
import { DbVersionService } from './modules/backups/db-version.service';
import { appVersion } from './modules/backups/manifest';
import { configureScriboApp } from './create-app';

async function bootstrap() {
    try {
        assertSetup(process.env);

        const app = await NestFactory.create(AppModule, {
            abortOnError: true,
            logger: ['error', 'warn'],
        });
        const startup = app.get(StartupService);
        await startup.assertDatabase();
        await startup.assertFiles();

        await configureScriboApp(app);
        const port = process.env.PORT ?? '3001';
        await app.listen(port, '0.0.0.0');
        console.log(`backend ready port=${port}`);
        const migration = app.get(DbVersionService).migration;
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
        const message =
            error instanceof Error
                ? (error.stack ?? error.message)
                : String(error);
        console.error(message);
        process.exit(1);
    }
}

void bootstrap();
