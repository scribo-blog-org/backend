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
import { LoggerService } from '../../infra/logger.service';
import {
    ChatMessage,
    type ChatSystemEvent,
} from '../../database/schemas/chat-message.schema';
import {
    Conversation,
    type ConversationRole,
} from '../../database/schemas/conversation.schema';
import { User } from '../../database/schemas/user.schema';
import { FilesService } from '../../files/files.service';
import { SocketService } from '../../socket/socket.service';
import { PushService } from '../push/push.service';
import { UsersService } from '../users/users.service';
import { ChatCrypto } from './chat-crypto';
import { chatStartedEmailTemplate } from './chat-started-email';

const MAX_GROUP_MEMBERS = 50;

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
    system_event?: ChatSystemEvent | null;
    deleted_at?: Date | null;
    edited_at?: Date | null;
    createdAt?: Date;
    created_at?: Date;
};

type ConversationLean = {
    _id: Types.ObjectId;
    participants: Types.ObjectId[];
    participant_key: string;
    kind?: 'direct' | 'group';
    title?: string;
    description?: string;
    photo?: string | null;
    members?: { user_id: Types.ObjectId; role: ConversationRole }[];
    last_message_id?: Types.ObjectId | null;
    last_message_text: string;
    last_message_sender_name?: string;
    last_message_at?: Date | null;
    last_read_at?: Record<string, Date>;
    createdAt?: Date;
};

@Injectable()
export class ChatService {
    private readonly crypto: ChatCrypto;

    constructor(
        @InjectModel(Conversation.name)
        private readonly conversations: Model<Conversation>,
        @InjectModel(ChatMessage.name)
        private readonly messages: Model<ChatMessage>,
        @InjectModel(User.name) private readonly users: Model<User>,
        private readonly usersService: UsersService,
        private readonly socketService: SocketService,
        private readonly push: PushService,
        private readonly files: FilesService,
        private readonly mail: MailService,
        private readonly config: ConfigService,
        private readonly logger: LoggerService,
    ) {
        this.crypto = new ChatCrypto(
            this.config.get<string>('CHAT_ENCRYPTION_KEYS') ?? '',
            this.config.get<string>('CHAT_ENCRYPTION_ACTIVE_KEY') ?? '',
        );
    }

    private participantKey(a: string, b: string) {
        return [String(a), String(b)].sort().join(':');
    }

    private isGroup(conversation: ConversationLean) {
        return conversation.kind === 'group';
    }

    private roleOf(conversation: ConversationLean, userId: string) {
        const member = (conversation.members || []).find(
            (item) => String(item.user_id) === userId,
        );
        if (member) {
            return member.role;
        }
        if (
            !this.isGroup(conversation) &&
            this.participantIds(conversation).includes(userId)
        ) {
            return 'member' as const;
        }
        return null;
    }

    private assertGroup(conversation: ConversationLean) {
        if (!this.isGroup(conversation)) {
            throw new BadRequestException('This conversation is not a group');
        }
    }

    private assertGroupAdmin(conversation: ConversationLean, actor: Actor) {
        this.assertGroup(conversation);
        if (this.roleOf(conversation, actor.id) !== 'admin') {
            throw new ForbiddenException(
                'Only administrators can change the group',
            );
        }
    }

    private adminCount(conversation: ConversationLean) {
        return (conversation.members || []).filter(
            (member) => member.role === 'admin',
        ).length;
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
        const systemEvent = message.system_event || null;

        return {
            _id: String(message._id),
            conversation_id: String(message.conversation_id),
            sender,
            text: message.deleted_at ? '' : this.crypto.decrypt(message.text),
            reply_to: message.reply_to ? String(message.reply_to) : null,
            system_event: systemEvent,
            deleted_at: message.deleted_at || null,
            edited_at: message.edited_at || null,
            created_at: createdAt,
            is_own: !systemEvent && String(sender?._id) === actor.id,
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
                    system_event: null,
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
            system_event: null,
            deleted_at: null,
            ...(lastRead ? { createdAt: { $gt: new Date(lastRead) } } : {}),
        });
    }

    private async serializeConversationListItem(
        row: ConversationLean,
        userId: string,
    ) {
        const unread = await this.unreadForConversation(row, userId);
        const base = {
            _id: String(row._id),
            last_message_text: row.last_message_text
                ? this.crypto.decrypt(row.last_message_text)
                : '',
            last_message_sender_name: row.last_message_sender_name || '',
            last_message_at: row.last_message_at,
            unread,
        };

        if (this.isGroup(row)) {
            return {
                ...base,
                kind: 'group' as const,
                title: row.title || 'Group',
                description: row.description || '',
                photo: row.photo || null,
                member_count: row.participants.length,
                my_role: this.roleOf(row, userId),
                participant: null,
            };
        }

        const otherId = this.otherParticipantId(row, userId);
        return {
            ...base,
            kind: 'direct' as const,
            participant: await this.serializeParticipant(otherId, userId),
        };
    }

    private async serializeGroupMembers(
        conversation: ConversationLean,
        viewerId: string,
    ) {
        const users = await this.users
            .find({ _id: { $in: conversation.participants } })
            .select(
                '_id nick_name avatar is_verified last_activity_at is_last_activity_public',
            )
            .lean<UserLean[]>();
        const byId = new Map(users.map((user) => [String(user._id), user]));

        return conversation.participants
            .map((id) => {
                const user = byId.get(String(id));
                const isOwner = String(id) === viewerId;
                const activityPublic = user?.is_last_activity_public !== false;
                return {
                    _id: String(id),
                    nick_name: user?.nick_name || 'User',
                    avatar: user?.avatar || null,
                    is_verified: Boolean(user?.is_verified),
                    role: this.roleOf(conversation, String(id)) || 'member',
                    is_last_activity_public: activityPublic,
                    last_activity_at:
                        isOwner || activityPublic
                            ? user?.last_activity_at || null
                            : null,
                };
            })
            .sort((a, b) => {
                if (a.role !== b.role) {
                    return a.role === 'admin' ? -1 : 1;
                }
                return a.nick_name.localeCompare(b.nick_name);
            });
    }

    private async serializeDetail(
        conversation: ConversationLean,
        actor: Actor,
    ) {
        if (!this.isGroup(conversation)) {
            const otherId = this.otherParticipantId(conversation, actor.id);
            return {
                _id: String(conversation._id),
                kind: 'direct' as const,
                participant: await this.serializeParticipant(otherId, actor.id),
                last_read_at: conversation.last_read_at || {},
            };
        }

        return {
            _id: String(conversation._id),
            kind: 'group' as const,
            title: conversation.title || '',
            description: conversation.description || '',
            photo: conversation.photo || null,
            my_role: this.roleOf(conversation, actor.id),
            members: await this.serializeGroupMembers(conversation, actor.id),
            last_read_at: conversation.last_read_at || {},
            participant: null,
        };
    }

    private parseMemberIds(raw?: string) {
        if (!raw?.trim()) {
            return [];
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            throw new BadRequestException('Invalid member list');
        }

        if (!Array.isArray(parsed)) {
            throw new BadRequestException('Invalid member list');
        }

        const ids = [...new Set(parsed.map((id) => String(id)))];
        if (ids.some((id) => !Types.ObjectId.isValid(id))) {
            throw new BadRequestException('Invalid member');
        }
        return ids;
    }

    private async assertUsersExist(ids: string[]) {
        if (!ids.length) {
            return;
        }
        const found = await this.users
            .find({
                _id: { $in: ids.map((id) => this.assertObjectId(id)) },
            })
            .select('_id')
            .lean<Array<{ _id: Types.ObjectId }>>();
        if (found.length !== ids.length) {
            throw new NotFoundException('User not found');
        }
    }

    private async reloadConversation(id: string) {
        const conversation = await this.conversations
            .findById(id)
            .lean<ConversationLean>();
        if (!conversation) {
            throw new NotFoundException('Conversation not found');
        }
        return conversation;
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

    private async actorNick(actor: Actor) {
        return actor.nick_name || (await this.senderNick(actor.id)) || 'User';
    }

    private async memberNick(userId: string) {
        return (await this.senderNick(userId)) || 'User';
    }

    private async addSystemMessage(
        conversation: ConversationLean,
        actorId: string,
        event: ChatSystemEvent,
        text: string,
        recipientIds?: string[],
    ) {
        const encrypted = this.crypto.encrypt(text);
        const created = await this.messages.create({
            conversation_id: conversation._id,
            sender_id: this.assertObjectId(actorId),
            text: encrypted,
            system_event: event,
        });
        const createdAt =
            (created.get('createdAt') as Date | undefined) || new Date();

        await this.conversations.findByIdAndUpdate(conversation._id, {
            $set: {
                last_message_id: created._id,
                last_message_text: encrypted,
                last_message_sender_name: '',
                last_message_at: createdAt,
            },
        });

        this.socketService.chatMessage(
            String(conversation._id),
            {
                _id: String(created._id),
                conversation_id: String(conversation._id),
                sender: { _id: actorId },
                text,
                reply_to: null,
                reply_preview: null,
                system_event: event,
                deleted_at: null,
                edited_at: null,
                created_at: createdAt,
                is_own: false,
                status: null,
            },
            recipientIds ?? this.participantIds(conversation),
        );
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
                subject: 'Someone started a conversation with you on Scribo',
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

    private async senderNick(
        sender: MessageLean['sender_id'] | string | null | undefined,
    ) {
        if (
            sender &&
            typeof sender === 'object' &&
            'nick_name' in sender &&
            sender.nick_name
        ) {
            return sender.nick_name;
        }

        const id =
            sender && typeof sender === 'object' && '_id' in sender
                ? String(sender._id)
                : String(sender || '');
        if (!Types.ObjectId.isValid(id)) {
            return '';
        }

        const user = await this.users
            .findById(id)
            .select('nick_name')
            .lean<{ nick_name?: string }>();
        return user?.nick_name || '';
    }

    private async fillMissingSenderNames(rows: ConversationLean[]) {
        const missing = rows.filter(
            (row) =>
                row.last_message_text &&
                !row.last_message_sender_name &&
                row.last_message_id,
        );
        if (!missing.length) {
            return;
        }

        const messages = await this.messages
            .find({
                _id: { $in: missing.map((row) => row.last_message_id) },
            })
            .select('_id sender_id system_event')
            .populate('sender_id', 'nick_name')
            .lean<MessageLean[]>();
        const names = new Map<string, string>();
        for (const message of messages) {
            if (message.system_event) {
                continue;
            }
            names.set(
                String(message._id),
                await this.senderNick(message.sender_id),
            );
        }

        for (const row of missing) {
            row.last_message_sender_name =
                names.get(String(row.last_message_id)) || '';
        }
    }

    async listConversations(actor: Actor) {
        const rows = await this.conversations
            .find({ participants: this.assertObjectId(actor.id) })
            .sort({ last_message_at: -1, updatedAt: -1 })
            .lean<ConversationLean[]>();

        await this.fillMissingSenderNames(rows);

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
                kind: 'direct',
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
            await this.logger.action('create_conversation', actor, {
                target_user: otherUserId,
                target_nick: other.nick_name,
                conversation: String(conversation._id),
            });
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
            kind: 'direct' as const,
            participant: await this.serializeParticipant(otherUserId, actor.id),
        };
    }

    async createGroup(
        actor: Actor,
        input: { name: string; description?: string; memberIds?: string },
        photo?: Express.Multer.File,
    ) {
        const title = String(input.name || '').trim();
        const description = String(input.description || '').trim();
        if (
            title.length < FIELD_LIMITS.groupName.min ||
            title.length > FIELD_LIMITS.groupName.max
        ) {
            throw new BadRequestException('Invalid group name');
        }
        if (description.length > FIELD_LIMITS.groupDescription.max) {
            throw new BadRequestException('Invalid group description');
        }

        const memberIds = this.parseMemberIds(input.memberIds).filter(
            (id) => id !== actor.id,
        );
        if (memberIds.length + 1 > MAX_GROUP_MEMBERS) {
            throw new BadRequestException('This group is full');
        }
        await this.assertUsersExist(memberIds);

        const id = new Types.ObjectId();
        let photoUrl: string | null = null;
        if (photo) {
            photoUrl = await this.files.saveImage(
                photo,
                'group',
                String(id),
                'groupPhoto',
            );
        }

        const participantIds = [actor.id, ...memberIds];
        const now = new Date();
        try {
            await this.conversations.create({
                _id: id,
                participant_key: `group:${String(id)}`,
                kind: 'group',
                title,
                description,
                photo: photoUrl,
                participants: participantIds.map((userId) =>
                    this.assertObjectId(userId),
                ),
                members: participantIds.map((userId) => ({
                    user_id: this.assertObjectId(userId),
                    role: userId === actor.id ? 'admin' : 'member',
                })),
                last_message_text: '',
                last_read_at: Object.fromEntries(
                    participantIds.map((userId) => [userId, now]),
                ),
            });
        } catch (error) {
            if (photoUrl) {
                await this.files.remove(photoUrl);
            }
            throw error;
        }

        await this.logger.action('create_group', actor, {
            conversation: String(id),
            title,
            members: memberIds.length,
        });
        await this.pushConversationUpdate(String(id), participantIds);
        return this.serializeDetail(
            await this.reloadConversation(String(id)),
            actor,
        );
    }

    async updateGroup(
        id: string,
        actor: Actor,
        input: { name?: string; description?: string; removePhoto?: string },
        photo?: Express.Multer.File,
    ) {
        const conversation = await this.getConversationForActor(id, actor);
        this.assertGroup(conversation);

        const update: Record<string, unknown> = {};
        if (input.name !== undefined) {
            const title = String(input.name).trim();
            if (
                title.length < FIELD_LIMITS.groupName.min ||
                title.length > FIELD_LIMITS.groupName.max
            ) {
                throw new BadRequestException('Invalid group name');
            }
            update.title = title;
        }
        if (input.description !== undefined) {
            const description = String(input.description).trim();
            if (description.length > FIELD_LIMITS.groupDescription.max) {
                throw new BadRequestException('Invalid group description');
            }
            update.description = description;
        }

        const removePhoto =
            input.removePhoto === 'true' || input.removePhoto === '1';
        if (photo || removePhoto) {
            if (conversation.photo) {
                await this.files.remove(conversation.photo);
            }
            if (photo) {
                const url = await this.files.saveImage(
                    photo,
                    'group',
                    String(conversation._id),
                    'groupPhoto',
                );
                if (!url) {
                    throw new BadRequestException('Could not save group photo');
                }
                update.photo = url;
            } else {
                update.photo = null;
            }
        }

        if (Object.keys(update).length) {
            await this.conversations.findByIdAndUpdate(conversation._id, {
                $set: update,
            });
            await this.logger.action('update_group', actor, {
                conversation: String(conversation._id),
                title: update.title ?? conversation.title ?? null,
                fields: Object.keys(update),
            });
            await this.addSystemMessage(
                conversation,
                actor.id,
                'group_updated',
                `${await this.actorNick(actor)} updated the group`,
            );
            await this.pushConversationUpdate(
                String(conversation._id),
                this.participantIds(conversation),
            );
        }

        return this.serializeDetail(
            await this.reloadConversation(String(conversation._id)),
            actor,
        );
    }

    async addGroupMember(id: string, actor: Actor, userId: string) {
        const conversation = await this.getConversationForActor(id, actor);
        this.assertGroup(conversation);
        if (userId === actor.id) {
            throw new BadRequestException(
                'This person is already in the group',
            );
        }
        await this.insertGroupMember(conversation, userId);
        await this.logger.action('add_group_member', actor, {
            conversation: String(conversation._id),
            title: conversation.title ?? null,
            target_user: userId,
            target_nick: await this.memberNick(userId),
        });

        const reloaded = await this.reloadConversation(
            String(conversation._id),
        );
        await this.addSystemMessage(
            reloaded,
            actor.id,
            'member_added',
            `${await this.actorNick(actor)} added ${await this.memberNick(userId)}`,
        );
        await this.pushConversationUpdate(
            String(reloaded._id),
            this.participantIds(reloaded),
        );

        return this.serializeDetail(reloaded, actor);
    }

    async getGroupInvite(id: string, actor?: Actor) {
        const conversation = await this.conversations
            .findById(id)
            .lean<ConversationLean>();
        if (!conversation || !this.isGroup(conversation)) {
            throw new NotFoundException('Conversation not found');
        }

        return {
            _id: String(conversation._id),
            title: conversation.title || 'Group',
            description: conversation.description || '',
            photo: conversation.photo || null,
            member_count: conversation.participants.length,
            joined: actor
                ? this.participantIds(conversation).includes(actor.id)
                : false,
        };
    }

    async joinGroup(id: string, actor: Actor) {
        const conversation = await this.conversations
            .findById(id)
            .lean<ConversationLean>();
        if (!conversation || !this.isGroup(conversation)) {
            throw new NotFoundException('Conversation not found');
        }
        if (this.participantIds(conversation).includes(actor.id)) {
            return this.serializeDetail(conversation, actor);
        }

        await this.insertGroupMember(conversation, actor.id);
        await this.logger.action('join_group', actor, {
            conversation: String(conversation._id),
            title: conversation.title ?? null,
        });

        const reloaded = await this.reloadConversation(
            String(conversation._id),
        );
        await this.addSystemMessage(
            reloaded,
            actor.id,
            'member_joined',
            `${await this.actorNick(actor)} joined via the invite link`,
        );
        await this.pushConversationUpdate(
            String(reloaded._id),
            this.participantIds(reloaded),
        );

        return this.serializeDetail(reloaded, actor);
    }

    private async insertGroupMember(
        conversation: ConversationLean,
        userId: string,
    ) {
        if (this.participantIds(conversation).includes(userId)) {
            throw new BadRequestException(
                'This person is already in the group',
            );
        }
        if (conversation.participants.length >= MAX_GROUP_MEMBERS) {
            throw new BadRequestException('This group is full');
        }
        await this.assertUsersExist([userId]);

        const now = new Date();
        await this.conversations.findByIdAndUpdate(conversation._id, {
            $addToSet: {
                participants: this.assertObjectId(userId),
                members: {
                    user_id: this.assertObjectId(userId),
                    role: 'member',
                },
            },
            $set: { [`last_read_at.${userId}`]: now },
        });

        await this.pushConversationUpdate(String(conversation._id), [
            ...this.participantIds(conversation),
            userId,
        ]);
    }

    async removeGroupMember(id: string, actor: Actor, userId: string) {
        const conversation = await this.getConversationForActor(id, actor);
        this.assertGroup(conversation);
        if (!this.participantIds(conversation).includes(userId)) {
            throw new NotFoundException('Member not found');
        }
        if (userId !== actor.id) {
            this.assertGroupAdmin(conversation, actor);
        }

        const targetRole = this.roleOf(conversation, userId);
        const remaining = conversation.participants.length - 1;
        if (
            targetRole === 'admin' &&
            this.adminCount(conversation) <= 1 &&
            remaining > 0
        ) {
            throw new BadRequestException(
                'Promote another administrator before leaving',
            );
        }

        if (remaining === 0) {
            return this.deleteConversation(id, actor);
        }

        const targetNick = await this.memberNick(userId);

        await this.conversations.findByIdAndUpdate(conversation._id, {
            $pull: {
                participants: this.assertObjectId(userId),
                members: { user_id: this.assertObjectId(userId) },
            },
            $unset: { [`last_read_at.${userId}`]: '' },
        });

        await this.logger.action(
            userId === actor.id ? 'leave_group' : 'remove_group_member',
            actor,
            {
                conversation: id,
                title: conversation.title ?? null,
                ...(userId === actor.id
                    ? {}
                    : { target_user: userId, target_nick: targetNick }),
            },
        );

        this.socketService.chatConversationDeleted(userId, id);
        await this.pushUnread(userId);
        const stayIds = this.participantIds(conversation).filter(
            (participantId) => participantId !== userId,
        );

        if (this.isGroup(conversation)) {
            const isLeaving = userId === actor.id;
            await this.addSystemMessage(
                conversation,
                actor.id,
                isLeaving ? 'member_left' : 'member_removed',
                isLeaving
                    ? `${targetNick} left the group`
                    : `${await this.actorNick(actor)} removed ${targetNick}`,
                stayIds,
            );
        }

        await this.pushConversationUpdate(id, stayIds);

        if (userId === actor.id) {
            return { _id: id, left: true };
        }

        return this.serializeDetail(await this.reloadConversation(id), actor);
    }

    async updateGroupMemberRole(
        id: string,
        actor: Actor,
        userId: string,
        role: ConversationRole,
    ) {
        const conversation = await this.getConversationForActor(id, actor);
        this.assertGroupAdmin(conversation, actor);
        if (!this.participantIds(conversation).includes(userId)) {
            throw new NotFoundException('Member not found');
        }
        const current = this.roleOf(conversation, userId);
        if (current === role) {
            return this.serializeDetail(conversation, actor);
        }
        if (
            current === 'admin' &&
            role === 'member' &&
            this.adminCount(conversation) <= 1
        ) {
            throw new BadRequestException(
                'The group needs at least one administrator',
            );
        }

        await this.conversations.findOneAndUpdate(
            {
                _id: conversation._id,
                'members.user_id': this.assertObjectId(userId),
            },
            { $set: { 'members.$.role': role } },
        );

        const actorNick = await this.actorNick(actor);
        const targetNick = await this.memberNick(userId);
        await this.logger.action('update_group_member_role', actor, {
            conversation: String(conversation._id),
            title: conversation.title ?? null,
            target_user: userId,
            target_nick: targetNick,
            previous_member_role: current,
            member_role: role,
        });
        await this.addSystemMessage(
            conversation,
            actor.id,
            role === 'admin' ? 'admin_granted' : 'admin_revoked',
            role === 'admin'
                ? `${actorNick} made ${targetNick} an administrator`
                : `${actorNick} removed administrator rights from ${targetNick}`,
        );

        await this.pushConversationUpdate(
            String(conversation._id),
            this.participantIds(conversation),
        );
        return this.serializeDetail(
            await this.reloadConversation(String(conversation._id)),
            actor,
        );
    }

    async getConversation(id: string, actor: Actor) {
        const conversation = await this.getConversationForActor(id, actor);
        return this.serializeDetail(conversation, actor);
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
        const otherIds = this.participantIds(conversation).filter(
            (participantId) => participantId !== actor.id,
        );

        const items = rows.reverse().map((row) => {
            const base = this.serializeMessage(row, actor);
            const reply = row.reply_to
                ? replyMap.get(String(row.reply_to))
                : null;
            const createdAt = this.messageDate(row);
            const allRead = otherIds.every((participantId) => {
                const readAt = conversation.last_read_at?.[participantId];
                return readAt && new Date(readAt) >= new Date(createdAt);
            });
            const status =
                String(base.sender?._id) === actor.id
                    ? allRead
                        ? 'read'
                        : 'sent'
                    : null;

            return {
                ...base,
                status,
                reply_preview: reply
                    ? {
                          _id: String(reply._id),
                          text: reply.deleted_at
                              ? ''
                              : this.crypto.decrypt(reply.text),
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

        const encrypted = this.crypto.encrypt(text);
        const created = await this.messages.create({
            conversation_id: conversation._id,
            sender_id: this.assertObjectId(actor.id),
            text: encrypted,
            reply_to: replyTo,
        });

        const populated = await this.messages
            .findById(created._id)
            .populate('sender_id', '_id nick_name avatar')
            .lean<MessageLean>();

        await this.conversations.findByIdAndUpdate(conversation._id, {
            $set: {
                last_message_id: created._id,
                last_message_text: encrypted,
                last_message_sender_name: actor.nick_name || '',
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

        await Promise.all(
            participantIds
                .filter((participantId) => participantId !== actor.id)
                .map((participantId) => this.pushUnread(participantId)),
        );

        const preview = text.length > 140 ? `${text.slice(0, 140)}…` : text;
        const isGroup = conversation.kind === 'group';
        const senderName = actor.nick_name || 'Someone';
        const senderAvatar = this.push.avatarUrl(
            (populated?.sender_id as { avatar?: string } | undefined)?.avatar,
        );
        await Promise.all(
            participantIds
                .filter((participantId) => participantId !== actor.id)
                .map((participantId) =>
                    this.push
                        .sendToUser(participantId, {
                            title: isGroup
                                ? conversation.title || 'Group chat'
                                : senderName,
                            body: isGroup
                                ? `${senderName}: ${preview}`
                                : preview,
                            url: `/chats/${String(conversation._id)}`,
                            tag: `chat:${String(conversation._id)}`,
                            icon: senderAvatar,
                        })
                        .catch(() => undefined),
                ),
        );

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
            text: reply.deleted_at ? '' : this.crypto.decrypt(reply.text),
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
        if (message.system_event) {
            throw new BadRequestException('System messages cannot be deleted');
        }
        const conversation = await this.getConversationForActor(
            String(message.conversation_id),
            actor,
        );

        const deletedAt = new Date();
        await this.messages.findByIdAndUpdate(messageId, {
            $set: { deleted_at: deletedAt },
        });

        if (String(conversation.last_message_id) === String(message._id)) {
            const latest = await this.messages
                .findOne({
                    conversation_id: conversation._id,
                    deleted_at: null,
                })
                .sort({ _id: -1 })
                .lean<MessageLean>();

            await this.conversations.findByIdAndUpdate(conversation._id, {
                $set: {
                    last_message_id: latest?._id ?? null,
                    last_message_text: latest?.text ?? '',
                    last_message_sender_name:
                        latest && !latest.system_event
                            ? await this.senderNick(latest.sender_id)
                            : '',
                    last_message_at: latest ? this.messageDate(latest) : null,
                },
            });
            await this.pushConversationUpdate(
                String(conversation._id),
                this.participantIds(conversation),
            );
        }

        await this.logger.action('delete_message', actor, {
            conversation: String(message.conversation_id),
            message_author: String(message.sender_id),
            own_message: String(message.sender_id) === actor.id,
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

    async deleteMessages(ids: string[], actor: Actor) {
        const unique = [...new Set(ids)];
        const objectIds = unique.map((id) => new Types.ObjectId(id));
        const rows = await this.messages
            .find({ _id: { $in: objectIds } })
            .lean<MessageLean[]>();

        if (rows.length !== unique.length) {
            throw new NotFoundException('Message not found');
        }
        if (rows.some((row) => row.system_event)) {
            throw new BadRequestException('System messages cannot be deleted');
        }

        const conversationIds = [
            ...new Set(rows.map((row) => String(row.conversation_id))),
        ];
        const conversations = new Map<string, ConversationLean>();

        for (const conversationId of conversationIds) {
            conversations.set(
                conversationId,
                await this.getConversationForActor(conversationId, actor),
            );
        }

        const deletedAt = new Date();
        await this.messages.updateMany(
            { _id: { $in: objectIds } },
            { $set: { deleted_at: deletedAt } },
        );
        await this.logger.action('delete_messages', actor, {
            conversations: conversationIds,
            count: rows.length,
        });

        for (const [conversationId, conversation] of conversations) {
            const removedLast = rows.some(
                (row) =>
                    String(row.conversation_id) === conversationId &&
                    String(row._id) === String(conversation.last_message_id),
            );

            if (!removedLast) {
                continue;
            }

            const latest = await this.messages
                .findOne({
                    conversation_id: conversation._id,
                    deleted_at: null,
                })
                .sort({ _id: -1 })
                .lean<MessageLean>();

            await this.conversations.findByIdAndUpdate(conversation._id, {
                $set: {
                    last_message_id: latest?._id ?? null,
                    last_message_text: latest?.text ?? '',
                    last_message_sender_name:
                        latest && !latest.system_event
                            ? await this.senderNick(latest.sender_id)
                            : '',
                    last_message_at: latest ? this.messageDate(latest) : null,
                },
            });
            await this.pushConversationUpdate(
                conversationId,
                this.participantIds(conversation),
            );
        }

        for (const conversationId of conversationIds) {
            const ids = rows
                .filter((row) => String(row.conversation_id) === conversationId)
                .map((row) => String(row._id));
            await this.socketService.chatMessagesDeleted(conversationId, ids);
        }

        const updated = await this.messages
            .find({ _id: { $in: objectIds } })
            .populate('sender_id', '_id nick_name avatar')
            .lean<MessageLean[]>();

        const payloads = [];

        for (const message of updated) {
            const conversation = conversations.get(
                String(message.conversation_id),
            );

            if (!conversation) {
                continue;
            }

            const payload = {
                ...this.serializeMessage(message, actor),
                status: 'sent',
                reply_preview: message.reply_to
                    ? await this.buildReplyPreview(
                          message.reply_to as Types.ObjectId,
                      )
                    : null,
            };

            this.socketService.chatMessage(
                String(message.conversation_id),
                payload,
                this.participantIds(conversation),
            );
            payloads.push(payload);
        }

        return payloads;
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
        if (message.system_event) {
            throw new BadRequestException('System messages cannot be edited');
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
        if (text === this.crypto.decrypt(message.text)) {
            throw new BadRequestException('Message text is unchanged');
        }

        const conversation = await this.getConversationForActor(
            String(message.conversation_id),
            actor,
        );

        const editedAt = new Date();
        const encrypted = this.crypto.encrypt(text);
        await this.messages.findByIdAndUpdate(messageId, {
            $set: { text: encrypted, edited_at: editedAt },
        });
        await this.logger.action('edit_message', actor, {
            conversation: String(message.conversation_id),
            text_length: text.length,
        });

        const conversationUpdate: Record<string, unknown> = {};
        if (String(conversation.last_message_id) === messageId) {
            conversationUpdate.last_message_text = encrypted;
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
        if (
            this.isGroup(conversation) &&
            conversation.participants.length > 1 &&
            this.roleOf(conversation, actor.id) !== 'admin'
        ) {
            throw new ForbiddenException(
                'Only administrators can delete the group',
            );
        }
        const participantIds = this.participantIds(conversation);
        if (conversation.photo) {
            await this.files.remove(conversation.photo);
        }
        const otherId = participantIds.find((id) => id !== actor.id);
        const other = otherId
            ? await this.users
                  .findById(otherId)
                  .select('nick_name')
                  .lean<{ nick_name?: string }>()
            : null;

        await this.messages.deleteMany({
            conversation_id: conversation._id,
        });
        await this.conversations.findByIdAndDelete(conversation._id);
        await this.logger.action('delete_conversation', actor, {
            target_user: otherId ?? null,
            target_nick: other?.nick_name ?? null,
            conversation: conversationId,
        });

        for (const userId of participantIds) {
            this.socketService.chatConversationDeleted(userId, conversationId);
            await this.pushUnread(userId);
        }

        return { _id: conversationId };
    }
}
