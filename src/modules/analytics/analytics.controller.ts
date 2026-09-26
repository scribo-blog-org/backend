import { Body, Controller, Get, Post, Query, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import { OptionalAuth } from '../../authz/decorators/public.decorator';
import { RequirePermissions } from '../../authz/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../authz/permissions';
import type { Actor } from '../../authz/policy';
import { DashboardQueryDto } from '../../http/query.dto';
import { AnalyticsService } from './analytics.service';
import { TrackVisitDto } from './dto/analytics.dto';

@ApiTags('analytics')
@Controller('analytics')
export class AnalyticsController {
    constructor(private readonly analytics: AnalyticsService) {}

    @OptionalAuth()
    @Post('visit')
    async visit(
        @Body() dto: TrackVisitDto,
        @CurrentUser() actor: Actor | undefined,
        @Req() req: Request,
    ) {
        const data = await this.analytics.trackVisit(dto, actor, req);
        return { status: true, message: 'Visit tracked', data };
    }

    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.VIEW_LOGS)
    @Get('dashboard')
    async dashboard(
        @Query() query: DashboardQueryDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.analytics.getDashboard(query, actor);
        return {
            status: true,
            message: 'Analytics fetched successfully',
            data,
        };
    }
}
