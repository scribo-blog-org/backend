import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import { RequirePermissions } from '../../authz/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../authz/permissions';
import type { Actor } from '../../authz/policy';
import {
    ListLogEntitiesQueryDto,
    ListLogsQueryDto,
    ListRuntimeLogsQueryDto,
} from '../../http/query.dto';
import { LogsQueryService } from './logs.service';
import { RuntimeLogsService, type RuntimeSource } from './runtime-logs.service';

@ApiTags('logs')
@Controller('logs')
export class LogsController {
    constructor(
        private readonly logs: LogsQueryService,
        private readonly runtimeLogs: RuntimeLogsService,
    ) {}

    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.VIEW_LOGS)
    @Get()
    async list(@Query() query: ListLogsQueryDto, @CurrentUser() actor: Actor) {
        const data = await this.logs.list(query, actor);
        return { status: true, message: 'Logs fetched successfully!', data };
    }

    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.VIEW_LOGS)
    @Get('runtime')
    runtime(@Query() query: ListRuntimeLogsQueryDto) {
        const { sources, ...rest } = query;
        const data = this.runtimeLogs.read({
            ...rest,
            sources: sources
                ? (sources.split(',') as RuntimeSource[])
                : undefined,
        });
        return {
            status: true,
            message: 'Runtime logs fetched successfully!',
            data,
        };
    }

    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.VIEW_LOGS)
    @Get('entities')
    async entities(
        @Query() query: ListLogEntitiesQueryDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.logs.entities(query, actor);
        return {
            status: true,
            message: 'Log entities fetched successfully!',
            data,
        };
    }
}
