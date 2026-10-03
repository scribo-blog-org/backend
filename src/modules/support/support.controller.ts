import {
    Body,
    Controller,
    Get,
    Param,
    Patch,
    Post,
    Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import { OptionalAuth } from '../../authz/decorators/public.decorator';
import { RequirePermissions } from '../../authz/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../authz/permissions';
import type { Actor } from '../../authz/policy';
import {
    CreateSupportDto,
    SupportReplyDto,
    SupportStatusDto,
} from './dto/support.dto';
import { ListSupportQueryDto } from '../../http/query.dto';
import { SupportService } from './support.service';

@ApiTags('support')
@Controller('support')
export class SupportController {
    constructor(private readonly support: SupportService) {}

    @OptionalAuth()
    @Post()
    async create(@Body() dto: CreateSupportDto, @CurrentUser() actor?: Actor) {
        const data = await this.support.create(dto, actor);
        return {
            status: true,
            message: 'Support request created successfully',
            data,
        };
    }

    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.MANAGE_SUPPORT)
    @Get()
    async list(
        @Query() query: ListSupportQueryDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.support.list(query, actor);
        return {
            status: true,
            message: 'Support requests fetched successfully',
            data,
        };
    }

    @ApiBearerAuth()
    @Get('mine')
    async mine(
        @Query() query: ListSupportQueryDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.support.listMine(query, actor);
        return {
            status: true,
            message: 'Support requests fetched successfully',
            data,
        };
    }

    @OptionalAuth()
    @Get('public/:key')
    async getPublic(@Param('key') key: string, @CurrentUser() actor?: Actor) {
        const data = await this.support.getPublic(key, actor);
        return {
            status: true,
            message: 'Support request fetched successfully',
            data,
        };
    }

    @OptionalAuth()
    @Post('public/:key/replies')
    async replyPublic(
        @Param('key') key: string,
        @Body() dto: SupportReplyDto,
        @CurrentUser() actor?: Actor,
    ) {
        const data = await this.support.replyPublic(key, dto.replyText, actor);
        return { status: true, message: 'Reply added', data };
    }

    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.MANAGE_SUPPORT)
    @Patch(':id/status')
    async status(
        @Param('id') id: string,
        @Body() dto: SupportStatusDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.support.updateStatus(
            id,
            dto.supportStatus,
            actor,
        );
        return { status: true, message: 'Status updated', data };
    }

    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.MANAGE_SUPPORT)
    @Get(':id')
    async get(@Param('id') id: string, @CurrentUser() actor: Actor) {
        const data = await this.support.getById(id, actor);
        return {
            status: true,
            message: 'Support request fetched successfully',
            data,
        };
    }

    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.MANAGE_SUPPORT)
    @Post(':id/replies')
    async reply(
        @Param('id') id: string,
        @Body() dto: SupportReplyDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.support.replyStaff(id, dto.replyText, actor);
        return { status: true, message: 'Reply added', data };
    }
}
