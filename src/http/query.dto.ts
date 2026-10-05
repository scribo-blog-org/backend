import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
    IsIn,
    IsInt,
    IsOptional,
    IsString,
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

    @ApiPropertyOptional({ isArray: true, type: String })
    @IsOptional()
    @Transform(({ value }) => joinRepeatableQuery({ value }))
    @IsString()
    category?: string;

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
    category?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    support_request?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    type?: string;
}

export class ListLogEntitiesQueryDto extends PaginationQueryDto {
    @ApiPropertyOptional({ description: 'Part of a name to look for' })
    @IsOptional()
    @IsString()
    @MaxLength(100)
    search?: string;
}

export class DashboardQueryDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @IsIn(['24h', '7', '14', '30'])
    days?: string;
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
