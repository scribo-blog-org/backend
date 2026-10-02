import {
    HttpException,
    HttpStatus,
    ServiceUnavailableException,
} from '@nestjs/common';
import type { ArgumentsHost } from '@nestjs/common';
import { Error as MongooseError } from 'mongoose';
import { ApiExceptionFilter } from './api-exception.filter';

function hostWith(
    request: Record<string, unknown>,
    response: { status: jest.Mock; json: jest.Mock },
): ArgumentsHost {
    return {
        switchToHttp: () => ({
            getRequest: () => request,
            getResponse: () => response,
        }),
    } as unknown as ArgumentsHost;
}

describe('ApiExceptionFilter', () => {
    it('maps mongoose CastError to 400 Incorrect type', () => {
        const json = jest.fn();
        const status = jest.fn().mockReturnValue({ json });
        const filter = new ApiExceptionFilter();
        const exception = new MongooseError.CastError(
            'ObjectId',
            '66b8787ab32781dff28fefefв',
            '_id',
        );

        filter.catch(
            exception,
            hostWith(
                { params: { id: '66b8787ab32781dff28fefefв' } },
                { status, json },
            ),
        );

        expect(status).toHaveBeenCalledWith(HttpStatus.BAD_REQUEST);
        expect(json).toHaveBeenCalledWith({
            status: false,
            message: 'Incorrect type!',
            data: null,
            errors: {
                params: {
                    id: {
                        message: 'Incorrect type!',
                        data: '66b8787ab32781dff28fefefв',
                    },
                },
            },
        });
    });
});

describe('ApiExceptionFilter logging', () => {
    const run = (exception: unknown) => {
        const json = jest.fn();
        const status = jest.fn().mockReturnValue({ json });
        const logger = { error: jest.fn().mockResolvedValue(undefined) };
        jest.spyOn(console, 'error').mockImplementation(() => undefined);
        new ApiExceptionFilter(logger as never).catch(
            exception,
            hostWith(
                {
                    method: 'POST',
                    originalUrl: '/api/posts?token=secret',
                    auth: { id: 'u1' },
                },
                { status, json },
            ),
        );
        return { logger, status };
    };

    afterEach(() => jest.restoreAllMocks());

    it('writes an unhandled error to the log without the query string', () => {
        const { logger, status } = run(new Error('db is down'));
        expect(status).toHaveBeenCalledWith(HttpStatus.INTERNAL_SERVER_ERROR);
        expect(logger.error).toHaveBeenCalledWith(
            expect.objectContaining({
                status: 500,
                method: 'POST',
                path: '/api/posts',
                message: 'db is down',
                user: 'u1',
            }),
        );
    });

    it('does not log client errors or the maintenance 503', () => {
        expect(
            run(new HttpException('bad', 400)).logger.error,
        ).not.toHaveBeenCalled();
        expect(
            run(new HttpException('nope', 404)).logger.error,
        ).not.toHaveBeenCalled();
        expect(
            run(new ServiceUnavailableException('restoring')).logger.error,
        ).not.toHaveBeenCalled();
    });
});
