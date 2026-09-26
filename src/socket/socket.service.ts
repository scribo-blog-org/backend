import { Injectable, Logger } from '@nestjs/common';
import { SocketEvents } from './socket.events';

@Injectable()
export class SocketService {
    private readonly logger = new Logger(SocketService.name);

    constructor(private readonly socketEvents: SocketEvents) {}

    userNotification(userId: string, notifications: unknown[]): void {
        void this.socketEvents
            .userNotification(userId, notifications)
            .catch((error: unknown) => {
                this.logger.error(
                    `Failed to send notification to user ${userId}`,
                    error instanceof Error ? error.stack : error,
                );
            });
    }

    chatMessage(
        conversationId: string,
        message: unknown,
        _participantIds: string[],
    ): void {
        void this.socketEvents
            .chatMessage(conversationId, message)
            .catch((error: unknown) => {
                this.logger.error(
                    `Failed to send chat message to ${conversationId}`,
                    error instanceof Error ? error.stack : error,
                );
            });
    }

    chatRead(
        conversationId: string,
        payload: unknown,
        _participantIds: string[],
    ): void {
        void this.socketEvents
            .chatRead(conversationId, payload)
            .catch((error: unknown) => {
                this.logger.error(
                    `Failed to send chat read to ${conversationId}`,
                    error instanceof Error ? error.stack : error,
                );
            });
    }

    chatUnread(userId: string, unread: number): void {
        void this.socketEvents
            .chatUnread(userId, unread)
            .catch((error: unknown) => {
                this.logger.error(
                    `Failed to send chat unread to user ${userId}`,
                    error instanceof Error ? error.stack : error,
                );
            });
    }

    chatConversation(userId: string, conversation: unknown): void {
        void this.socketEvents
            .chatConversation(userId, conversation)
            .catch((error: unknown) => {
                this.logger.error(
                    `Failed to send chat conversation to user ${userId}`,
                    error instanceof Error ? error.stack : error,
                );
            });
    }

    chatConversationDeleted(userId: string, conversationId: string): void {
        void this.socketEvents
            .chatConversationDeleted(userId, conversationId)
            .catch((error: unknown) => {
                this.logger.error(
                    `Failed to send chat deletion to user ${userId}`,
                    error instanceof Error ? error.stack : error,
                );
            });
    }
}
