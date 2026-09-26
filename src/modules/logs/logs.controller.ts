import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import { RequirePermissions } from '../../authz/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../authz/permissions';
import type { Actor } from '../../authz/policy';
import { ListLogsQueryDto } from '../../http/query.dto';
import { LogsQueryService } from './logs.service';

@ApiTags('logs')
@Controller('logs')
export class LogsController {
    constructor(private readonly logs: LogsQueryService) {}

    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.VIEW_LOGS)
    @Get()
    async list(@Query() query: ListLogsQueryDto, @CurrentUser() actor: Actor) {
        const data = await this.logs.list(query, actor);
        return { status: true, message: 'Logs fetched successfully!', data };
    }
}
