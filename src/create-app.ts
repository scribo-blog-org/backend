import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { NestExpressApplication } from '@nestjs/platform-express';
import {
    UPLOADS_URL_PATH,
    backendServesUploads,
    uploadsDir,
} from './files/files.config';
import { ApiExceptionFilter } from './http/api-exception.filter';
import { LoggerService } from './infra/logger.service';
import { requestContextMiddleware } from './infra/request-context';
import { openApiDocument } from './http/openapi-document';
import { ScriboValidationPipe } from './http/scribo-validation.pipe';

function isLocalBrowserOrigin(origin: string): boolean {
    try {
        const url = new URL(origin);
        return (
            url.protocol === 'http:' &&
            (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
        );
    } catch {
        return false;
    }
}

function loggerOf(app: INestApplication): LoggerService | undefined {
    try {
        return app.get(LoggerService, { strict: false });
    } catch {
        return undefined;
    }
}

export async function configureScriboApp(
    app: INestApplication,
): Promise<INestApplication> {
    const http = app.getHttpAdapter().getInstance() as {
        set: (key: string, value: unknown) => void;
    };
    http.set('trust proxy', 1);

    const configuredOrigins = [process.env.FRONTEND_ORIGIN].filter(
        Boolean,
    ) as string[];
    const allowLocalCors =
        process.env.NODE_ENV !== 'production' &&
        process.env.VERCEL_ENV !== 'production';

    app.setGlobalPrefix('api', {
        exclude: [{ path: 'health', method: RequestMethod.GET }],
    });
    app.use(cookieParser());
    app.use(requestContextMiddleware);
    // В проде каталог отдаёт nginx мимо Node. Здесь это только для разработки.
    if (backendServesUploads(process.env)) {
        (app as NestExpressApplication).useStaticAssets(
            uploadsDir({ get: (key: string) => process.env[key] }),
            {
                prefix: UPLOADS_URL_PATH,
                index: false,
                dotfiles: 'deny',
                // Аватар перезаписывается под тем же именем: перепроверка по ETag.
                setHeaders: (res) => {
                    res.setHeader('Cache-Control', 'public, no-cache');
                    res.setHeader('X-Content-Type-Options', 'nosniff');
                    res.setHeader(
                        'Cross-Origin-Resource-Policy',
                        'cross-origin',
                    );
                },
            },
        );
    }
    app.useGlobalPipes(new ScriboValidationPipe());
    app.useGlobalFilters(new ApiExceptionFilter(loggerOf(app)));
    app.enableCors({
        origin: (
            requestOrigin: string | undefined,
            callback: (err: Error | null, allow?: boolean) => void,
        ) => {
            if (!requestOrigin) return callback(null, true);
            if (
                configuredOrigins.includes(requestOrigin) ||
                requestOrigin.endsWith('.vercel.app') ||
                (allowLocalCors && isLocalBrowserOrigin(requestOrigin))
            ) {
                return callback(null, true);
            }
            return callback(null, false);
        },
        credentials: true,
        methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization'],
        exposedHeaders: ['Set-Cookie'],
        optionsSuccessStatus: 200,
    });

    const pkg = JSON.parse(
        readFileSync(join(process.cwd(), 'package.json'), 'utf8'),
    ) as { version: string };
    const port = process.env.PORT ?? '3001';
    const apiOrigin = process.env.API_ORIGIN || `http://localhost:${port}`;

    const swagger = new DocumentBuilder()
        .setTitle('Scribo API')
        .setDescription(
            'Scribo HTTP API. Responses use { status, message, data }.',
        )
        .setVersion(pkg.version)
        .addServer(apiOrigin)
        .addBearerAuth()
        .addCookieAuth('refresh_token')
        .build();

    const document = SwaggerModule.createDocument(app, swagger);
    Object.assign(document.info, { 'x-backend-version': pkg.version });
    openApiDocument.current = document as unknown as Record<string, unknown>;

    SwaggerModule.setup('swagger', app, document, {
        useGlobalPrefix: true,
        jsonDocumentUrl: 'docs-json',
    });

    return app;
}
