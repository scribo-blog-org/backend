import {
    Body,
    Controller,
    Delete,
    Get,
    Param,
    Patch,
    Post,
    Query,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { ApiBearerAuth, ApiConsumes, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import { OptionalAuth } from '../../authz/decorators/public.decorator';
import type { Actor } from '../../authz/policy';
import { imageFileInterceptor } from '../../files/upload';
import { ChatService } from './chat.service';
import {
    AddGroupMemberDto,
    CreateConversationDto,
    CreateGroupDto,
    DeleteMessagesDto,
    EditMessageDto,
    ListMessagesQueryDto,
    SendMessageDto,
    UpdateGroupMemberRoleDto,
} from './dto/chat.dto';

@ApiTags('chat')
@ApiBearerAuth()
@Controller('chat')
export class ChatController {
    constructor(private readonly chat: ChatService) {}

    @Get('unread-count')
    async unreadCount(@CurrentUser() actor: Actor) {
        const data = await this.chat.getUnreadCount(actor);
        return { status: true, message: 'Unread count fetched', data };
    }

    @Get('conversations')
    async listConversations(@CurrentUser() actor: Actor) {
        const data = await this.chat.listConversations(actor);
        return { status: true, message: 'Conversations fetched', data };
    }

    @Post('conversations/group')
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(imageFileInterceptor('groupPhoto'))
    async createGroup(
        @Body() dto: CreateGroupDto,
        @UploadedFile() photo: Express.Multer.File | undefined,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.createGroup(actor, dto, photo);
        return { status: true, message: 'Group created', data };
    }

    @Patch('conversations/:id/group')
    @ApiConsumes('multipart/form-data')
    @UseInterceptors(imageFileInterceptor('groupPhoto'))
    async updateGroup(
        @Param('id') id: string,
        @Body() dto: CreateGroupDto,
        @UploadedFile() photo: Express.Multer.File | undefined,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.updateGroup(id, actor, dto, photo);
        return { status: true, message: 'Group updated', data };
    }

    @Post('conversations/:id/members')
    async addMember(
        @Param('id') id: string,
        @Body() dto: AddGroupMemberDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.addGroupMember(id, actor, dto.userId);
        return { status: true, message: 'Member added', data };
    }

    @Delete('conversations/:id/members/:userId')
    async removeMember(
        @Param('id') id: string,
        @Param('userId') userId: string,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.removeGroupMember(id, actor, userId);
        return { status: true, message: 'Member removed', data };
    }

    @Patch('conversations/:id/members/:userId')
    async updateMemberRole(
        @Param('id') id: string,
        @Param('userId') userId: string,
        @Body() dto: UpdateGroupMemberRoleDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.updateGroupMemberRole(
            id,
            actor,
            userId,
            dto.role,
        );
        return { status: true, message: 'Role updated', data };
    }

    @Post('conversations')
    async createConversation(
        @Body() dto: CreateConversationDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.createConversation(actor, dto.userId);
        return { status: true, message: 'Conversation ready', data };
    }

    @OptionalAuth()
    @Get('conversations/:id/invite')
    async groupInvite(
        @Param('id') id: string,
        @CurrentUser() actor?: Actor,
    ) {
        const data = await this.chat.getGroupInvite(id, actor);
        return { status: true, message: 'Group invite fetched', data };
    }

    @Post('conversations/:id/join')
    async joinGroup(@Param('id') id: string, @CurrentUser() actor: Actor) {
        const data = await this.chat.joinGroup(id, actor);
        return { status: true, message: 'Joined the group', data };
    }

    @Get('conversations/:id')
    async getConversation(
        @Param('id') id: string,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.getConversation(id, actor);
        return { status: true, message: 'Conversation fetched', data };
    }

    @Delete('conversations/:id')
    async deleteConversation(
        @Param('id') id: string,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.deleteConversation(id, actor);
        return { status: true, message: 'Conversation deleted', data };
    }

    @Get('conversations/:id/messages')
    async listMessages(
        @Param('id') id: string,
        @Query() query: ListMessagesQueryDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.listMessages(id, actor, query);
        return { status: true, message: 'Messages fetched', data };
    }

    @Post('conversations/:id/messages')
    async sendMessage(
        @Param('id') id: string,
        @Body() dto: SendMessageDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.sendMessage(id, actor, {
            text: dto.text,
            replyTo: dto.replyTo,
        });
        return { status: true, message: 'Message sent', data };
    }

    @Post('conversations/:id/read')
    async markRead(@Param('id') id: string, @CurrentUser() actor: Actor) {
        const data = await this.chat.markRead(id, actor);
        return { status: true, message: 'Conversation marked as read', data };
    }

    @Post('messages/bulk-delete')
    async deleteMessages(
        @Body() dto: DeleteMessagesDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.deleteMessages(dto.ids, actor);
        return { status: true, message: 'Messages deleted', data };
    }

    @Delete('messages/:id')
    async deleteMessage(@Param('id') id: string, @CurrentUser() actor: Actor) {
        const data = await this.chat.deleteMessage(id, actor);
        return { status: true, message: 'Message deleted', data };
    }

    @Patch('messages/:id')
    async editMessage(
        @Param('id') id: string,
        @Body() dto: EditMessageDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.editMessage(id, actor, { text: dto.text });
        return { status: true, message: 'Message edited', data };
    }
}
