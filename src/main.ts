import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertSetup } from './common/startup';
import { StartupService } from './common/startup.service';
import { configureScriboApp } from './create-app';

async function bootstrap() {
    const logger = new Logger('Startup');
    try {
        assertSetup(process.env);
        logger.log('setup ok');

        const app = await NestFactory.create(AppModule, { abortOnError: true });
        const startup = app.get(StartupService);
        await startup.assertDatabase();
        await startup.assertAws();

        await configureScriboApp(app);
        const port = process.env.PORT ?? '3001';
        await app.listen(port);
        logger.log(`listening on ${port}`);
    } catch (error) {
        const message =
            error instanceof Error
                ? (error.stack ?? error.message)
                : String(error);
        logger.error(message);
        process.exit(1);
    }
}

void bootstrap();
