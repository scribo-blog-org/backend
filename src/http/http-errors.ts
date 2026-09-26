import { HttpException, HttpStatus } from '@nestjs/common';
import type { Request } from 'express';
import type { ValidationError } from 'class-validator';

export type ErrorSource = 'body' | 'params' | 'query';

export type FieldErrorItem = {
    message: string;
    data: unknown;
};

export type ErrorBag = Partial<
    Record<ErrorSource, Record<string, FieldErrorItem>>
>;

export class FieldException extends HttpException {
    readonly field: string;
    readonly data: unknown;

    constructor(
        field: string,
        message: string,
        data: unknown = '',
        status: HttpStatus = HttpStatus.BAD_REQUEST,
    ) {
        super({ message, field, data }, status);
        this.field = field;
        this.data = data;
    }
}

export class FieldBagException extends HttpException {
    readonly errors: ErrorBag;

    constructor(errors: ErrorBag, message = 'Some errors in your fields!') {
        super({ message, errors }, HttpStatus.BAD_REQUEST);
        this.errors = errors;
    }

    static fromValidation(source: ErrorSource, errors: ValidationError[]) {
        const fields: Record<string, FieldErrorItem> = {};
        for (const item of flattenValidation(errors)) {
            fields[item.field] = { message: item.message, data: item.data };
        }
        return new FieldBagException({ [source]: fields });
    }
}

export function fieldError(
    field: string,
    message: string,
    data: unknown = '',
    status: HttpStatus = HttpStatus.BAD_REQUEST,
) {
    return new FieldException(field, message, data, status);
}

export function sourceFromRequest(
    request: Request,
    field: string,
): ErrorSource {
    if (Object.prototype.hasOwnProperty.call(request.params ?? {}, field)) {
        return 'params';
    }
    if (Object.prototype.hasOwnProperty.call(request.query ?? {}, field)) {
        return 'query';
    }
    if (Object.prototype.hasOwnProperty.call(request.body ?? {}, field)) {
        return 'body';
    }
    return 'body';
}

export function bagFromField(
    source: ErrorSource,
    field: string,
    message: string,
    data: unknown,
) {
    return {
        [source]: {
            [field]: { message, data },
        },
    } satisfies ErrorBag;
}

function flattenValidation(
    errors: ValidationError[],
    parent = '',
): { field: string; message: string; data: unknown }[] {
    const items: { field: string; message: string; data: unknown }[] = [];
    for (const error of errors) {
        const field = parent ? `${parent}.${error.property}` : error.property;
        const messages = error.constraints
            ? Object.values(error.constraints)
            : [];
        if (messages.length) {
            items.push({
                field,
                message: messages[0],
                data: error.value,
            });
        }
        if (error.children?.length) {
            items.push(...flattenValidation(error.children, field));
        }
    }
    return items;
}
