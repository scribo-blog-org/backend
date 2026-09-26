import {
    BadRequestException,
    ForbiddenException,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Actor } from '../../authz/policy';
import { FIELD_LIMITS } from '../../validation/field-limits';
import { MailService } from '../../infra/mail.service';
import { ChatMessage } from '../../database/schemas/chat-message.schema';
import { Conversation } from '../../database/schemas/conversation.schema';
import { User } from '../../database/schemas/user.schema';
import { SocketService } from '../../socket/socket.service';
import { UsersService } from '../users/users.service';
import { chatStartedEmailTemplate } from './chat-started-email';

type UserLean = {
    _id: Types.ObjectId;
    nick_name: string;
    avatar?: string;
    email?: string;
    is_verified?: boolean;
    last_activity_at?: Date;
    is_last_activity_public?: boolean;
};

type MessageLean = {
    _id: Types.ObjectId;
    conversation_id: Types.ObjectId;
    sender_id: Types.ObjectId | UserLean;
    text: string;
    reply_to?: Types.ObjectId | null;
    deleted_at?: Date | null;
    edited_at?: Date | null;
    createdAt?: Date;
    created_at?: Date;
};

type ConversationLean = {
    _id: Types.ObjectId;
    participants: Types.ObjectId[];
    participant_key: string;
    last_message_id?: Types.ObjectId | null;
    last_message_text: string;
    last_message_at?: Date | null;
    last_read_at?: Record<string, Date>;
    createdAt?: Date;
};

@Injectable()
export class ChatService {
    constructor(
        @InjectModel(Conversation.name)
        private readonly conversations: Model<Conversation>,
        @InjectModel(ChatMessage.name)
        private readonly messages: Model<ChatMessage>,
        @InjectModel(User.name) private readonly users: Model<User>,
        private readonly usersService: UsersService,
        private readonly socketService: SocketService,
        private readonly mail: MailService,
        private readonly config: ConfigService,
    ) {}

    private participantKey(a: string, b: string) {
        return [String(a), String(b)].sort().join(':');
    }

    private assertObjectId(value: string, label = 'id') {
        if (!Types.ObjectId.isValid(value)) {
            throw new BadRequestException(`Invalid ${label}`);
        }
        return new Types.ObjectId(value);
    }

    private messageDate(message: MessageLean) {
        return message.createdAt || message.created_at || new Date(0);
    }

    private async getConversationForActor(id: string, actor: Actor) {
        const conversation = await this.conversations
            .findById(id)
            .lean<ConversationLean>();
        if (!conversation) {
            throw new NotFoundException('Conversation not found');
        }
        const isParticipant = conversation.participants.some(
            (participant) => String(participant) === actor.id,
        );
        if (!isParticipant) {
            throw new ForbiddenException(
                "You don't have access to this conversation",
            );
        }
        return conversation;
    }

    private participantIds(conversation: ConversationLean) {
        return conversation.participants.map((participant) =>
            String(participant),
        );
    }

    private otherParticipantId(
        conversation: ConversationLean,
        actorId: string,
    ) {
        const other = conversation.participants.find(
            (participant) => String(participant) !== actorId,
        );
        if (!other) {
            throw new BadRequestException('Invalid conversation participants');
        }
        return String(other);
    }

    private serializeUser(user: UserLean | Types.ObjectId | string | null) {
        if (!user || typeof user === 'string') {
            return null;
        }
        if (user instanceof Types.ObjectId) {
            return { _id: String(user) };
        }
        return {
            _id: String(user._id),
            nick_name: user.nick_name,
            avatar: user.avatar || null,
        };
    }

    private async serializeParticipant(otherId: string, viewerId: string) {
        const user = await this.usersService.getById(otherId, {
            viewerId,
        });
        if (!user) {
            return null;
        }

        return {
            _id: String(user._id),
            nick_name: user.nick_name,
            avatar: user.avatar || null,
            is_verified: Boolean(user.is_verified),
            last_activity_at: user.last_activity_at || null,
            is_last_activity_public: user.is_last_activity_public,
        };
    }

    private serializeMessage(message: MessageLean, actor: Actor) {
        const sender =
            message.sender_id instanceof Types.ObjectId
                ? { _id: String(message.sender_id) }
                : this.serializeUser(message.sender_id as UserLean);
        const createdAt = this.messageDate(message);

        return {
            _id: String(message._id),
            conversation_id: String(message.conversation_id),
            sender,
            text: message.deleted_at ? '' : message.text,
            reply_to: message.reply_to ? String(message.reply_to) : null,
            deleted_at: message.deleted_at || null,
            edited_at: message.edited_at || null,
            created_at: createdAt,
            is_own: String(sender?._id) === actor.id,
        };
    }

    private async unreadCountForUser(userId: string) {
        const conversations = await this.conversations
            .find({ participants: this.assertObjectId(userId) })
            .select({
                _id: 1,
                last_message_at: 1,
                last_read_at: 1,
                participants: 1,
            })
            .lean<ConversationLean[]>();

        let total = 0;
        for (const conversation of conversations) {
            const lastRead =
                conversation.last_read_at?.[userId] ||
                conversation.last_read_at?.[String(userId)];
            const lastMessageAt = conversation.last_message_at;
            if (!lastMessageAt) {
                continue;
            }
            if (!lastRead || new Date(lastRead) < new Date(lastMessageAt)) {
                const count = await this.messages.countDocuments({
                    conversation_id: conversation._id,
                    sender_id: { $ne: this.assertObjectId(userId) },
                    deleted_at: null,
                    ...(lastRead
                        ? { createdAt: { $gt: new Date(lastRead) } }
                        : {}),
                });
                total += count;
            }
        }
        return total;
    }

    private async pushUnread(userId: string) {
        const unread = await this.unreadCountForUser(userId);
        this.socketService.chatUnread(userId, unread);
        return unread;
    }

    private async unreadForConversation(row: ConversationLean, userId: string) {
        const lastRead = row.last_read_at?.[userId];
        const lastMessageAt = row.last_message_at;
        if (
            !lastMessageAt ||
            (lastRead && new Date(lastRead) >= new Date(lastMessageAt))
        ) {
            return 0;
        }

        return this.messages.countDocuments({
            conversation_id: row._id,
            sender_id: { $ne: this.assertObjectId(userId) },
            deleted_at: null,
            ...(lastRead ? { createdAt: { $gt: new Date(lastRead) } } : {}),
        });
    }

    private async serializeConversationListItem(
        row: ConversationLean,
        userId: string,
    ) {
        const otherId = this.otherParticipantId(row, userId);
        const unread = await this.unreadForConversation(row, userId);

        return {
            _id: String(row._id),
            participant: await this.serializeParticipant(otherId, userId),
            last_message_text: row.last_message_text,
            last_message_at: row.last_message_at,
            unread,
        };
    }

    private async pushConversationUpdate(
        conversationId: string,
        userIds: string[],
    ) {
        const conversation = await this.conversations
            .findById(conversationId)
            .lean<ConversationLean>();
        if (!conversation) {
            return;
        }

        for (const userId of userIds) {
            const item = await this.serializeConversationListItem(
                conversation,
                userId,
            );
            this.socketService.chatConversation(userId, item);
        }
    }

    private notifyChatStarted(
        recipient: { email?: string | null; nick_name?: string | null },
        initiatorNickName: string | null | undefined,
        conversationId: string,
    ) {
        if (!recipient.email) {
            return;
        }

        const origin = this.config.get<string>('FRONTEND_ORIGIN');
        const messagesUrl = origin
            ? `${String(origin).replace(/\/$/, '')}/messages/${conversationId}`
            : '';

        if (!messagesUrl) {
            return;
        }

        void this.mail
            .sendEmail({
                to: recipient.email,
                subject: 'С вами начали переписку в Scribo',
                html: chatStartedEmailTemplate({
                    recipientNickName: recipient.nick_name,
                    initiatorNickName,
                    messagesUrl,
                }),
            })
            .catch((error) => {
                console.error('Failed to send chat started email', error);
            });
    }

    async getUnreadCount(actor: Actor) {
        return { unread: await this.unreadCountForUser(actor.id) };
    }

    async listConversations(actor: Actor) {
        const rows = await this.conversations
            .find({ participants: this.assertObjectId(actor.id) })
            .sort({ last_message_at: -1, updatedAt: -1 })
            .lean<ConversationLean[]>();

        const items = await Promise.all(
            rows.map((row) =>
                this.serializeConversationListItem(row, actor.id),
            ),
        );

        return items;
    }

    async createConversation(actor: Actor, otherUserId: string) {
        if (otherUserId === actor.id) {
            throw new BadRequestException('Cannot chat with yourself');
        }

        const other = await this.users.findById(otherUserId).lean<UserLean>();
        if (!other) {
            throw new NotFoundException('User not found');
        }

        const participant_key = this.participantKey(actor.id, otherUserId);
        let conversation = await this.conversations
            .findOne({ participant_key })
            .lean<ConversationLean>();
        let isNew = false;

        if (!conversation) {
            const created = await this.conversations.create({
                participant_key,
                participants: [
                    this.assertObjectId(actor.id),
                    this.assertObjectId(otherUserId),
                ],
                last_message_text: '',
                last_read_at: {
                    [actor.id]: new Date(),
                    [otherUserId]: new Date(),
                },
            });
            conversation = created.toObject() as ConversationLean;
            isNew = true;
        }

        if (isNew) {
            await this.pushConversationUpdate(String(conversation._id), [
                actor.id,
                otherUserId,
            ]);

            const recipient = await this.users
                .findById(otherUserId)
                .select('email nick_name')
                .lean<{ email?: string; nick_name?: string }>();
            if (recipient) {
                this.notifyChatStarted(
                    recipient,
                    actor.nick_name,
                    String(conversation._id),
                );
            }
        }

        return {
            _id: String(conversation._id),
            participant: await this.serializeParticipant(otherUserId, actor.id),
        };
    }

    async getConversation(id: string, actor: Actor) {
        const conversation = await this.getConversationForActor(id, actor);
        const otherId = this.otherParticipantId(conversation, actor.id);

        return {
            _id: String(conversation._id),
            participant: await this.serializeParticipant(otherId, actor.id),
            last_read_at: conversation.last_read_at || {},
        };
    }

    async listMessages(
        conversationId: string,
        actor: Actor,
        query: { before?: string; limit?: string },
    ) {
        await this.getConversationForActor(conversationId, actor);
        const limit = Math.min(
            Math.max(Number.parseInt(query.limit || '50', 10) || 50, 1),
            100,
        );
        const filter: Record<string, unknown> = {
            conversation_id: this.assertObjectId(conversationId),
        };
        if (query.before) {
            filter._id = { $lt: this.assertObjectId(query.before) };
        }

        const rows = await this.messages
            .find(filter)
            .sort({ _id: -1 })
            .limit(limit)
            .populate('sender_id', '_id nick_name avatar')
            .lean<MessageLean[]>();

        const replyIds = rows
            .map((row) => row.reply_to)
            .filter(Boolean) as Types.ObjectId[];
        const replies = replyIds.length
            ? await this.messages
                  .find({ _id: { $in: replyIds } })
                  .select('_id text deleted_at sender_id')
                  .populate('sender_id', '_id nick_name')
                  .lean<MessageLean[]>()
            : [];
        const replyMap = new Map(
            replies.map((reply) => [String(reply._id), reply]),
        );

        const conversation = await this.getConversationForActor(
            conversationId,
            actor,
        );
        const otherId = this.otherParticipantId(conversation, actor.id);
        const otherLastRead = conversation.last_read_at?.[otherId];

        const items = rows.reverse().map((row) => {
            const base = this.serializeMessage(row, actor);
            const reply = row.reply_to
                ? replyMap.get(String(row.reply_to))
                : null;
            const createdAt = this.messageDate(row);
            const status =
                String(base.sender?._id) === actor.id
                    ? otherLastRead &&
                      new Date(otherLastRead) >= new Date(createdAt)
                        ? 'read'
                        : 'sent'
                    : null;

            return {
                ...base,
                status,
                reply_preview: reply
                    ? {
                          _id: String(reply._id),
                          text: reply.deleted_at ? '' : reply.text,
                          deleted: Boolean(reply.deleted_at),
                          sender: this.serializeUser(
                              reply.sender_id as UserLean,
                          ),
                      }
                    : null,
            };
        });

        return { items, has_more: rows.length === limit };
    }

    async sendMessage(
        conversationId: string,
        actor: Actor,
        input: { text: string; replyTo?: string },
    ) {
        const conversation = await this.getConversationForActor(
            conversationId,
            actor,
        );
        const text = String(input.text || '').trim();
        if (
            text.length < FIELD_LIMITS.chatMessage.min ||
            text.length > FIELD_LIMITS.chatMessage.max
        ) {
            throw new BadRequestException('Invalid message text');
        }

        let replyTo: Types.ObjectId | null = null;
        if (input.replyTo) {
            const parent = await this.messages
                .findOne({
                    _id: this.assertObjectId(input.replyTo),
                    conversation_id: conversation._id,
                })
                .lean<MessageLean>();
            if (!parent) {
                throw new NotFoundException('Reply target not found');
            }
            replyTo = parent._id;
        }

        const created = await this.messages.create({
            conversation_id: conversation._id,
            sender_id: this.assertObjectId(actor.id),
            text,
            reply_to: replyTo,
        });

        const populated = await this.messages
            .findById(created._id)
            .populate('sender_id', '_id nick_name avatar')
            .lean<MessageLean>();

        await this.conversations.findByIdAndUpdate(conversation._id, {
            $set: {
                last_message_id: created._id,
                last_message_text: text,
                last_message_at: new Date(),
            },
        });

        const payload = {
            ...this.serializeMessage(populated!, actor),
            status: 'sent',
            reply_preview: replyTo
                ? await this.buildReplyPreview(replyTo)
                : null,
        };

        this.socketService.chatMessage(
            String(conversation._id),
            payload,
            this.participantIds(conversation),
        );

        const participantIds = this.participantIds(conversation);
        await this.pushConversationUpdate(
            String(conversation._id),
            participantIds,
        );

        const otherId = this.otherParticipantId(conversation, actor.id);
        await this.pushUnread(otherId);

        return payload;
    }

    private async buildReplyPreview(replyTo: Types.ObjectId) {
        const reply = await this.messages
            .findById(replyTo)
            .populate('sender_id', '_id nick_name')
            .lean<MessageLean>();
        if (!reply) {
            return null;
        }
        return {
            _id: String(reply._id),
            text: reply.deleted_at ? '' : reply.text,
            deleted: Boolean(reply.deleted_at),
            sender: this.serializeUser(reply.sender_id as UserLean),
        };
    }

    async deleteMessage(messageId: string, actor: Actor) {
        const message = await this.messages
            .findById(messageId)
            .lean<MessageLean>();
        if (!message) {
            throw new NotFoundException('Message not found');
        }
        if (String(message.sender_id) !== actor.id) {
            throw new ForbiddenException("You can't delete this message");
        }
        const conversation = await this.getConversationForActor(
            String(message.conversation_id),
            actor,
        );

        const deletedAt = new Date();
        await this.messages.findByIdAndUpdate(messageId, {
            $set: { deleted_at: deletedAt },
        });

        const updated = await this.messages
            .findById(messageId)
            .populate('sender_id', '_id nick_name avatar')
            .lean<MessageLean>();

        if (!updated) {
            throw new NotFoundException('Message not found');
        }

        const payload = {
            ...this.serializeMessage(updated, actor),
            status: 'sent',
            reply_preview: updated?.reply_to
                ? await this.buildReplyPreview(
                      updated.reply_to as Types.ObjectId,
                  )
                : null,
        };

        this.socketService.chatMessage(
            String(message.conversation_id),
            payload,
            this.participantIds(conversation),
        );

        return payload;
    }

    async editMessage(
        messageId: string,
        actor: Actor,
        input: { text: string },
    ) {
        const message = await this.messages
            .findById(messageId)
            .lean<MessageLean>();
        if (!message) {
            throw new NotFoundException('Message not found');
        }
        if (String(message.sender_id) !== actor.id) {
            throw new ForbiddenException("You can't edit this message");
        }
        if (message.deleted_at) {
            throw new BadRequestException('Deleted messages cannot be edited');
        }

        const text = String(input.text || '').trim();
        if (
            text.length < FIELD_LIMITS.chatMessage.min ||
            text.length > FIELD_LIMITS.chatMessage.max
        ) {
            throw new BadRequestException('Invalid message text');
        }
        if (text === message.text) {
            throw new BadRequestException('Message text is unchanged');
        }

        const conversation = await this.getConversationForActor(
            String(message.conversation_id),
            actor,
        );

        const editedAt = new Date();
        await this.messages.findByIdAndUpdate(messageId, {
            $set: { text, edited_at: editedAt },
        });

        const conversationUpdate: Record<string, unknown> = {};
        if (String(conversation.last_message_id) === messageId) {
            conversationUpdate.last_message_text = text;
        }
        if (Object.keys(conversationUpdate).length) {
            await this.conversations.findByIdAndUpdate(conversation._id, {
                $set: conversationUpdate,
            });
        }

        const updated = await this.messages
            .findById(messageId)
            .populate('sender_id', '_id nick_name avatar')
            .lean<MessageLean>();

        if (!updated) {
            throw new NotFoundException('Message not found');
        }

        const payload = {
            ...this.serializeMessage(updated, actor),
            status: 'sent',
            reply_preview: updated.reply_to
                ? await this.buildReplyPreview(
                      updated.reply_to as Types.ObjectId,
                  )
                : null,
        };

        this.socketService.chatMessage(
            String(message.conversation_id),
            payload,
            this.participantIds(conversation),
        );

        if (Object.keys(conversationUpdate).length) {
            await this.pushConversationUpdate(
                String(conversation._id),
                this.participantIds(conversation),
            );
        }

        return payload;
    }

    async markRead(conversationId: string, actor: Actor) {
        const conversation = await this.getConversationForActor(
            conversationId,
            actor,
        );
        const now = new Date();
        const lastRead = {
            ...(conversation.last_read_at || {}),
            [actor.id]: now,
        };

        await this.conversations.findByIdAndUpdate(conversation._id, {
            $set: { last_read_at: lastRead },
        });

        this.socketService.chatRead(
            String(conversation._id),
            {
                user_id: actor.id,
                read_at: now,
                last_message_id: conversation.last_message_id
                    ? String(conversation.last_message_id)
                    : null,
            },
            this.participantIds(conversation),
        );

        await this.pushUnread(actor.id);
        await this.pushConversationUpdate(String(conversation._id), [actor.id]);

        return { read_at: now };
    }

    async deleteConversation(conversationId: string, actor: Actor) {
        const conversation = await this.getConversationForActor(
            conversationId,
            actor,
        );
        const participantIds = this.participantIds(conversation);

        await this.messages.deleteMany({
            conversation_id: conversation._id,
        });
        await this.conversations.findByIdAndDelete(conversation._id);

        for (const userId of participantIds) {
            this.socketService.chatConversationDeleted(userId, conversationId);
            await this.pushUnread(userId);
        }

        return { _id: conversationId };
    }
}
