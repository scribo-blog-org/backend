import {
    ArgumentsHost,
    Catch,
    ExceptionFilter,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { Error as MongooseError } from 'mongoose';
import type { LoggerService } from '../infra/logger.service';
import { currentRequest } from '../infra/request-context';
import { RateLimitedException } from './rate-limit.guard';
import { MulterError } from 'multer';
import {
    bagFromField,
    FieldBagException,
    FieldException,
    sourceFromRequest,
} from './http-errors';

@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
    constructor(private readonly logger?: LoggerService) {}

    catch(exception: unknown, host: ArgumentsHost) {
        const ctx = host.switchToHttp();
        const response = ctx.getResponse<Response>();
        const request = ctx.getRequest<Request>();

        if (exception instanceof MongooseError.CastError) {
            const field =
                exception.path === '_id' ? 'id' : exception.path || 'id';
            const message = 'Incorrect type!';
            const source = sourceFromRequest(request, field);
            response.status(HttpStatus.BAD_REQUEST).json({
                status: false,
                message,
                data: null,
                request_id: currentRequest()?.id ?? null,
                errors: bagFromField(source, field, message, exception.value),
            });
            return;
        }

        if (exception instanceof MulterError) {
            const field = exception.field || 'file';
            const message =
                exception.code === 'LIMIT_FILE_SIZE'
                    ? 'Max size of image should be 5 MB!'
                    : exception.message;
            response.status(HttpStatus.BAD_REQUEST).json({
                status: false,
                message,
                data: null,
                request_id: currentRequest()?.id ?? null,
                errors: bagFromField('body', field, message, exception.code),
            });
            return;
        }

        const isHttp = exception instanceof HttpException;
        const status = isHttp
            ? exception.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR;
        const body = isHttp ? exception.getResponse() : null;
        let message = 'Internal server error';

        if (typeof body === 'string') {
            message = body;
        } else if (body && typeof body === 'object' && 'message' in body) {
            const raw = (body as { message: string | string[] }).message;
            message = Array.isArray(raw) ? raw.join(', ') : String(raw);
        } else if (exception instanceof Error) {
            message = exception.message;
        }

        if (!isHttp) {
            console.error(exception);
        }
        if (status >= 500 && status !== HttpStatus.SERVICE_UNAVAILABLE) {
            const auth = (request as { auth?: { id?: string } }).auth;
            void this.logger?.error({
                status,
                method: request.method,
                path: (request.originalUrl || request.url || '').split('?')[0],
                message,
                stack: exception instanceof Error ? exception.stack : undefined,
                user: auth?.id ?? null,
            });
        }

        this.logRefusal(exception, status, request);

        const payload: Record<string, unknown> = {
            status: false,
            message,
            data: null,
            request_id: currentRequest()?.id ?? null,
        };

        if (exception instanceof FieldException) {
            const source = sourceFromRequest(request, exception.field);
            payload.errors = bagFromField(
                source,
                exception.field,
                exception.message,
                exception.data,
            );
        } else if (exception instanceof FieldBagException) {
            payload.errors = exception.errors;
        } else if (body && typeof body === 'object' && 'errors' in body) {
            payload.errors = (body as { errors: unknown }).errors;
        }

        response.status(status).json(payload);
    }

    private logRefusal(exception: unknown, status: number, request: Request) {
        if (!this.logger) return;
        if (
            status !== HttpStatus.FORBIDDEN &&
            status !== HttpStatus.TOO_MANY_REQUESTS
        ) {
            return;
        }
        const auth = (request as { auth?: { id?: string } }).auth;
        const route =
            typeof request.route?.path === 'string'
                ? `${request.method} ${request.baseUrl || ''}${request.route.path}`
                : `${request.method} ${(request.originalUrl || request.url || '').split('?')[0]}`;
        const who = auth?.id ?? currentRequest()?.ip ?? 'unknown';
        const limited = status === HttpStatus.TOO_MANY_REQUESTS;
        void this.logger.diagnostic({
            type: limited ? 'rate_limited' : 'access_denied',
            message: limited
                ? `Rate limit hit on ${route}`
                : `Access denied on ${route}`,
            key: `${limited ? 'rate_limited' : 'access_denied'}|${who}|${route}`,
            data: {
                route,
                status,
                ...(limited && exception instanceof RateLimitedException
                    ? { rule: exception.rule }
                    : {}),
                ...(auth?.id ? { user: auth.id } : {}),
            },
        });
    }
}
