import { Injectable, ForbiddenException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { PERMISSIONS } from '../../authz/permissions';
import { hasPermission, type Actor } from '../../authz/policy';
import { paginationMeta, parsePagination } from '../../http/pagination';
import type { ListLogsQueryDto } from '../../http/query.dto';
import { AppLog } from '../../database/schemas/log.schema';
import { Category } from '../../database/schemas/category.schema';
import { Post } from '../../database/schemas/post.schema';
import { User } from '../../database/schemas/user.schema';
import { entitiesPipeline, escapeRegex, toEntities } from './log-entities';

@Injectable()
export class LogsQueryService {
    constructor(
        @InjectModel(AppLog.name) private readonly logs: Model<AppLog>,
        @InjectModel(User.name) private readonly users: Model<User>,
        @InjectModel(Post.name) private readonly posts: Model<Post>,
        @InjectModel(Category.name)
        private readonly categories: Model<Category>,
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
        if (query.user) {
            filter.$or = [
                'data.user',
                'data.target_user',
                'data.updated_user',
            ].map((path) => this.idMatch(path, query.user!));
        }
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
        if (query.role) {
            filter.$or = [
                { 'data.old_role': query.role },
                { 'data.new_role': query.role },
            ];
        }
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

    async entities(
        query: { search?: string; page?: number; limit?: number },
        actor: Actor,
    ) {
        if (!hasPermission(actor, PERMISSIONS.VIEW_LOGS)) {
            throw new ForbiddenException(
                "You don't have permission to view logs",
            );
        }
        const { page, limit, skip } = parsePagination(query, 20, 50);
        const text = (query.search ?? '').trim();
        const regex = text ? new RegExp(escapeRegex(text), 'i') : null;

        const [facet] = await this.logs.aggregate<{
            items: Parameters<typeof toEntities>[0];
            total: Array<{ n: number }>;
        }>(
            entitiesPipeline({
                regex,
                collections: {
                    users: this.users.collection.name,
                    posts: this.posts.collection.name,
                    categories: this.categories.collection.name,
                },
                skip,
                limit,
            }),
        );
        return {
            items: toEntities(facet?.items ?? []),
            pagination: paginationMeta(page, limit, facet?.total?.[0]?.n ?? 0),
        };
    }
}
