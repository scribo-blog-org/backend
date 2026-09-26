import { Injectable, Logger } from '@nestjs/common';
import { RedisPublisher } from './redis.publisher';

@Injectable()
export class SocketEvents {
    private readonly logger = new Logger(SocketEvents.name);

    constructor(private readonly redis: RedisPublisher) {}

    chatRoom(conversationId: string) {
        return `chat:${conversationId}`;
    }

    private async broadcast(
        room: string,
        event: string,
        payload: unknown,
    ): Promise<void> {
        try {
            await this.redis.publish(room, event, payload);
        } catch (error: unknown) {
            this.logger.error(
                `Redis publish failed for ${room} ${event}`,
                error instanceof Error ? error.stack : error,
            );
        }
    }

    async userNotification(
        userId: string,
        notifications: unknown[],
    ): Promise<void> {
        await this.broadcast(`user:${userId}`, 'notification', {
            notifications,
        });
    }

    async chatMessage(conversationId: string, message: unknown): Promise<void> {
        await this.broadcast(this.chatRoom(conversationId), 'chat:message', {
            message,
        });
    }

    async chatRead(conversationId: string, payload: unknown): Promise<void> {
        await this.broadcast(
            this.chatRoom(conversationId),
            'chat:read',
            payload,
        );
    }

    async chatUnread(userId: string, unread: number): Promise<void> {
        await this.broadcast(`user:${userId}`, 'chat:unread', { unread });
    }

    async chatConversation(
        userId: string,
        conversation: unknown,
    ): Promise<void> {
        await this.broadcast(`user:${userId}`, 'chat:conversation', {
            conversation,
        });
    }

    async chatConversationDeleted(
        userId: string,
        conversationId: string,
    ): Promise<void> {
        await this.broadcast(`user:${userId}`, 'chat:conversation-deleted', {
            conversation_id: conversationId,
        });
    }
}
