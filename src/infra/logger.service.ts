import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppLog } from '../database/schemas/log.schema';

@Injectable()
export class LoggerService {
    constructor(
        @InjectModel(AppLog.name) private readonly logs: Model<AppLog>,
    ) {}

    async log(input: {
        type: string;
        message: string;
        data?: Record<string, unknown> | null;
    }) {
        if (
            typeof input.type !== 'string' ||
            typeof input.message !== 'string'
        ) {
            return;
        }
        try {
            await this.logs.create({
                type: input.type,
                message: input.message,
                data: input.data ?? null,
            });
        } catch (error) {
            console.error(error);
        }
    }
}
