import { Injectable, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PERMISSIONS } from '../../authz/permissions';
import { hasPermission, type Actor } from '../../authz/policy';
import { paginationMeta, parsePagination } from '../../http/pagination';
import type { ListLogsQueryDto } from '../../http/query.dto';
import { AppLog } from '../../database/schemas/log.schema';

@Injectable()
export class LogsQueryService {
    constructor(
        @InjectModel(AppLog.name) private readonly logs: Model<AppLog>,
    ) {}

    private idMatch(path: string, value: string) {
        if (!Types.ObjectId.isValid(value)) {
            return { [path]: value };
        }
        return { [path]: { $in: [value, new Types.ObjectId(value)] } };
    }

    async list(query: ListLogsQueryDto, actor: Actor) {
        if (!hasPermission(actor, PERMISSIONS.VIEW_LOGS)) {
            throw new ForbiddenException(
                "You don't have permission to view logs",
            );
        }
        const { page, limit, skip } = parsePagination(query, 9, 50);
        const filter: Record<string, unknown> = {};
        if (query.user)
            Object.assign(filter, this.idMatch('data.user', query.user));
        if (query.post)
            Object.assign(filter, this.idMatch('data.post', query.post));
        if (query.category)
            Object.assign(
                filter,
                this.idMatch('data.category', query.category),
            );
        if (query.support_request)
            Object.assign(
                filter,
                this.idMatch('data.support_request', query.support_request),
            );
        if (query.type) filter.type = query.type;
        const total = await this.logs.countDocuments(filter);
        const items = await this.logs
            .find(filter)
            .sort({ date_time: -1 })
            .skip(skip)
            .limit(limit)
            .lean();
        return {
            items,
            pagination: paginationMeta(page, limit, total),
        };
    }
}
