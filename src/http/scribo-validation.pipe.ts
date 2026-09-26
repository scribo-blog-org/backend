import {
    ArgumentMetadata,
    BadRequestException,
    Injectable,
    ValidationPipe,
} from '@nestjs/common';
import type { ValidationError } from 'class-validator';
import { FieldBagException, type ErrorSource } from './http-errors';

const TYPE_TO_SOURCE: Record<string, ErrorSource> = {
    body: 'body',
    query: 'query',
    param: 'params',
    custom: 'body',
};

@Injectable()
export class ScriboValidationPipe extends ValidationPipe {
    constructor() {
        super({
            whitelist: true,
            transform: true,
            forbidNonWhitelisted: false,
            exceptionFactory: (errors: ValidationError[]) =>
                new BadRequestException({ validation: errors }),
        });
    }

    override async transform(value: unknown, metadata: ArgumentMetadata) {
        try {
            return await super.transform(value, metadata);
        } catch (error) {
            if (error instanceof BadRequestException) {
                const response = error.getResponse();
                if (
                    response &&
                    typeof response === 'object' &&
                    'validation' in response
                ) {
                    const source = TYPE_TO_SOURCE[metadata.type] ?? 'body';
                    throw FieldBagException.fromValidation(
                        source,
                        (response as { validation: ValidationError[] })
                            .validation,
                    );
                }
            }
            throw error;
        }
    }
}
