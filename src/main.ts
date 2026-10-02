import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { assertSetup } from './config/startup';
import { StartupService } from './infra/startup.service';
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
