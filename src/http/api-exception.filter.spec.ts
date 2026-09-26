import { HttpStatus } from '@nestjs/common';
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
