import { Injectable, PipeTransform } from '@nestjs/common';
import { Types } from 'mongoose';
import { fieldError } from './http-errors';

const OBJECT_ID_HEX = /^[a-fA-F0-9]{24}$/;

export function isMongoObjectId(value: unknown): value is string {
    return typeof value === 'string' && OBJECT_ID_HEX.test(value);
}

export function requireMongoId(value: unknown, field = 'id'): string {
    if (!isMongoObjectId(value)) {
        throw fieldError(field, 'Incorrect type!', value ?? '');
    }
    return value;
}

export function toObjectId(value: unknown, field = 'id'): Types.ObjectId {
    return new Types.ObjectId(requireMongoId(value, field));
}

@Injectable()
export class ParseMongoIdPipe implements PipeTransform<string, string> {
    transform(value: string) {
        return requireMongoId(value);
    }
}
