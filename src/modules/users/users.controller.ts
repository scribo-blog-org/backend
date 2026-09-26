import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
} from '@nestjs/common';
import { SocketService } from '../../socket/socket.service';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import { OptionalAuth } from '../../authz/decorators/public.decorator';
import { RequirePermissions } from '../../authz/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../authz/permissions';
import type { Actor } from '../../authz/policy';
import { ROLE_VALUES, type Role } from '../../authz/roles';
import { fieldError } from '../../http/http-errors';
import { ListUsersQueryDto } from '../../http/query.dto';
import { UpdateRoleDto } from '../auth/dto/auth.dto';
import { UsersService } from './users.service';

@ApiTags('users')
@Controller('users')
export class UsersController {
    constructor(
        private readonly users: UsersService,
        private readonly socket: SocketService,
    ) {}

    @OptionalAuth()
    @Get()
    @ApiOperation({ summary: 'List users' })
    async list(
        @Query() query: ListUsersQueryDto,
        @CurrentUser() actor: Actor | undefined,
    ) {
        const data = await this.users.getUsers({
            nick_name: query.nick_name,
            _id: query._id,
            is_verified: query.is_verified,
            viewerId: actor?.id,
        });
        return { status: true, message: 'Users fetched', data };
    }

    @OptionalAuth()
    @Get(':nick_name')
    async byNick(
        @Param('nick_name') nickName: string,
        @CurrentUser() actor: Actor | undefined,
    ) {
        const data = await this.users.getByNickName(nickName, actor?.id);
        return { status: true, message: 'User fetched', data };
    }

    @ApiBearerAuth()
    @Post(':id/follow')
    async follow(@Param('id') id: string, @CurrentUser() actor: Actor) {
        const data = await this.users.follow(id, actor);
        return { status: true, message: 'Followed', data };
    }

    @ApiBearerAuth()
    @Delete(':id/follow')
    async unfollow(@Param('id') id: string, @CurrentUser() actor: Actor) {
        const data = await this.users.unfollow(id, actor);
        return { status: true, message: 'Unfollowed', data };
    }

    @ApiBearerAuth()
    @RequirePermissions(PERMISSIONS.MANAGE_ROLES)
    @Patch(':id/role')
    async updateRole(
        @Param('id') id: string,
        @Body() dto: UpdateRoleDto,
        @CurrentUser() actor: Actor,
    ) {
        if (!ROLE_VALUES.includes(dto.userRole as Role)) {
            throw fieldError('userRole', 'Invalid role', dto.userRole);
        }
        const data = await this.users.updateRole(
            id,
            dto.userRole as Role,
            actor,
        );
        return { status: true, message: 'Role updated', data };
    }
}
