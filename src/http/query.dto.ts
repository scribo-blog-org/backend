import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    IsIn,
    IsInt,
    IsISO8601,
    IsOptional,
    IsString,
    Matches,
    Max,
    MaxLength,
    Min,
} from 'class-validator';

function joinRepeatableQuery({
    value,
}: {
    value: unknown;
}): string | undefined {
    if (value == null || value === '') {
        return undefined;
    }
    const parts = (Array.isArray(value) ? value : [value])
        .flatMap((item) => String(item).split(','))
        .map((item) => item.trim())
        .filter(Boolean);
    return parts.length ? parts.join(',') : undefined;
}

export class PaginationQueryDto {
    @ApiPropertyOptional()
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    page?: number;

    @ApiPropertyOptional()
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(50)
    limit?: number;
}

export class ListPostsQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional({ isArray: true, type: String })
    @IsOptional()
    @Transform(({ value }) => joinRepeatableQuery({ value }))
    @IsString()
    author?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    expand?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    created_date?: string;

    @ApiPropertyOptional({ isArray: true, type: String })
    @IsOptional()
    @Transform(({ value }) => joinRepeatableQuery({ value }))
    @IsString()
    ids?: string;

    @ApiPropertyOptional({ name: '_id', isArray: true, type: String })
    @IsOptional()
    @Transform(({ value, obj }) =>
        joinRepeatableQuery({ value: value ?? obj._id ?? obj.id }),
    )
    @IsString()
    _id?: string;

    @ApiPropertyOptional({ isArray: true, type: String })
    @IsOptional()
    @Transform(({ value }) => joinRepeatableQuery({ value }))
    @IsString()
    id?: string;
}

export class ListUsersQueryDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    nick_name?: string;

    @ApiPropertyOptional({ name: '_id', isArray: true, type: String })
    @IsOptional()
    @Transform(({ obj }) => {
        const raw = obj._id ?? obj.id;
        if (raw == null || raw === '') {
            return undefined;
        }
        return (Array.isArray(raw) ? raw : [raw]).map(String);
    })
    @IsString({ each: true })
    _id?: string[];

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    is_verified?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    is_admin?: string;
}

export class AdminListUsersQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(100)
    search?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @IsIn(['activity', 'registered'])
    sort?: string;

    @ApiPropertyOptional({
        description: 'Comma separated roles, or "staff" for everyone but users',
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    roles?: string;
}

export class ListRuntimeLogsQueryDto {
    @ApiPropertyOptional({
        description: 'Comma separated services: backend, socket, frontend',
    })
    @IsOptional()
    @Matches(/^(backend|socket|frontend)(,(backend|socket|frontend))*$/)
    sources?: string;

    @ApiPropertyOptional({ description: 'Comma separated levels' })
    @IsOptional()
    @IsString()
    @MaxLength(40)
    level?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MaxLength(200)
    q?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsISO8601()
    from?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsISO8601()
    to?: string;

    @ApiPropertyOptional({ description: 'Cursor: entries older than this' })
    @IsOptional()
    @IsISO8601()
    before?: string;

    @ApiPropertyOptional({
        description:
            'Cursor: entries newer than this (the nearest ones, newest first)',
    })
    @IsOptional()
    @IsISO8601()
    after?: string;

    @ApiPropertyOptional({ description: 'Exact HTTP status code' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(100)
    @Max(599)
    status?: number;

    @ApiPropertyOptional({ description: 'Minimum duration, ms' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    min_ms?: number;

    @ApiPropertyOptional({ description: 'Maximum duration, ms' })
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(0)
    max_ms?: number;

    @ApiPropertyOptional()
    @IsOptional()
    @Type(() => Number)
    @IsInt()
    @Min(1)
    @Max(500)
    limit?: number;
}

export class ListLogsQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    user?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    post?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    support_request?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    conversation?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    role?: string;

    @ApiPropertyOptional({ description: 'Comma separated event types' })
    @IsOptional()
    @IsString()
    @MaxLength(1000)
    type?: string;

    @ApiPropertyOptional({
        description: 'Text to find in any field of an event',
    })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    search?: string;

    @ApiPropertyOptional({ description: 'Every event of one request' })
    @IsOptional()
    @IsString()
    @MaxLength(64)
    request?: string;

    @ApiPropertyOptional({
        description: 'Comma separated: info, warn, error, problems',
    })
    @IsOptional()
    @Matches(/^(info|warn|error|problems)(,(info|warn|error|problems))*$/)
    level?: string;

    @ApiPropertyOptional({ description: 'Only events at or after this time' })
    @IsOptional()
    @IsISO8601()
    from?: string;

    @ApiPropertyOptional({ description: 'Only events at or before this time' })
    @IsOptional()
    @IsISO8601()
    to?: string;
}

export class ListLogEntitiesQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Part of a name to look for' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    search?: string;
}

export class DashboardQueryDto {
    @ApiPropertyOptional({
        enum: ['24h', '7', '30', 'custom'],
        description: 'Length of the period. "custom" needs from and to',
    })
    @IsOptional()
    @IsString()
    @IsIn(['24h', '7', '30', 'custom'])
    period?: string;

    @ApiPropertyOptional({
        description: 'First day of a custom period, YYYY-MM-DD (UTC)',
    })
    @IsOptional()
    @IsString()
    @Matches(/^\d{4}-\d{2}-\d{2}$/)
    from?: string;

    @ApiPropertyOptional({
        description: 'Last day of a custom period, YYYY-MM-DD (UTC)',
    })
    @IsOptional()
    @IsString()
    @Matches(/^\d{4}-\d{2}-\d{2}$/)
    to?: string;
}

export class ListSupportQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    status?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    kind?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    sort?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    order?: string;
}
