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
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import type { Actor } from '../../authz/policy';
import { ChatService } from './chat.service';
import {
    CreateConversationDto,
    DeleteMessagesDto,
    EditMessageDto,
    ListMessagesQueryDto,
    SendMessageDto,
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

    @Post('conversations')
    async createConversation(
        @Body() dto: CreateConversationDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.chat.createConversation(actor, dto.userId);
        return { status: true, message: 'Conversation ready', data };
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
