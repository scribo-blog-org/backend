import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { Public } from './authz/decorators/public.decorator';
import { openApiDocument } from './http/openapi-document';

@Controller()
export class AppController {
    @Public()
    @Get()
    ping() {
        return {
            status: true,
            message: 'Scribo API',
            data: { ok: true },
        };
    }

    @Public()
    @Get('health')
    health() {
        return {
            status: true,
            message: 'ok',
            data: { ok: true },
        };
    }

    @Public()
    @Get('docs')
    docs() {
        if (!openApiDocument.current) {
            throw new ServiceUnavailableException(
                'OpenAPI document is not ready',
            );
        }
        return {
            status: true,
            message: 'Docs fetched successfully',
            data: openApiDocument.current,
        };
    }
}
