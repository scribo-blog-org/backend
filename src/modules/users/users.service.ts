import {
    ConflictException,
    ForbiddenException,
    Injectable,
    NotFoundException,
    OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { canManageRole } from '../../authz/policy';
import type { Actor } from '../../authz/policy';
import { DEFAULT_ROLE, type Role } from '../../authz/roles';
import { LoggerService } from '../../infra/logger.service';
import { NotificationsService } from '../notifications/notifications.service';
import { tryConsume } from '../../http/rate-limit.guard';
import { Session } from '../../database/schemas/session.schema';
import { User } from '../../database/schemas/user.schema';

type UserLean = {
    _id: Types.ObjectId;
    nick_name: string;
    email: string;
    password?: string;
    role: Role;
    avatar?: string;
    is_verified?: boolean;
    is_saved_posts_public?: boolean;
    is_last_activity_public?: boolean;
    last_activity_at?: Date;
    saved_posts?: unknown[];
    follows: unknown[];
    followers: unknown[];
    notifications?: unknown[];
};

@Injectable()
export class UsersService implements OnModuleInit {
    constructor(
        @InjectModel(User.name) private readonly users: Model<User>,
        @InjectModel(Session.name) private readonly sessions: Model<Session>,
        private readonly logger: LoggerService,
        private readonly notificationsService: NotificationsService,
    ) {}

    touchLastActivity(userId: string) {
        if (!userId || !Types.ObjectId.isValid(userId)) {
            return;
        }
        if (!tryConsume(`last-activity:${userId}`, 10_000, 1)) {
            return;
        }

        setImmediate(() => {
            void this.users.collection
                .updateOne(
                    { _id: new Types.ObjectId(userId) },
                    { $set: { last_activity_at: new Date() } },
                )
                .catch(() => undefined);
        });
    }

    async onModuleInit() {
        await this.users.collection.updateMany(
            {
                $or: [
                    { last_activity_at: { $exists: false } },
                    { last_activity_at: null },
                ],
            },
            [{ $set: { last_activity_at: '$created_date' } }],
        );
        await this.users.updateMany(
            { is_last_activity_public: { $exists: false } },
            { $set: { is_last_activity_public: true } },
        );
    }

    sanitize(
        user: UserLean | null,
        options: {
            withPassword?: boolean;
            withSavedPosts?: boolean;
            withNotifications?: boolean;
            viewerId?: string;
        } = {},
    ) {
        if (!user) return null;
        const copy = { ...user } as UserLean;
        if (!options.withPassword) delete copy.password;
        if (options.withSavedPosts === false) {
            delete copy.saved_posts;
        } else if (
            options.withSavedPosts !== true &&
            copy.is_saved_posts_public === false
        ) {
            delete copy.saved_posts;
        }
        if (!options.withNotifications) delete copy.notifications;
        const isOwner =
            options.viewerId && String(copy._id) === options.viewerId;
        if (!isOwner && copy.is_last_activity_public === false) {
            delete copy.last_activity_at;
        }
        return copy;
    }

    async getById(
        id: string,
        options?: {
            withPassword?: boolean;
            withNotifications?: boolean;
            withSavedPosts?: boolean;
            viewerId?: string;
        },
    ) {
        const user = await this.users.findById(id).lean<UserLean>();
        return this.sanitize(user, options);
    }

    async getByQuery(
        query: Record<string, unknown>,
        options?: { withPassword?: boolean; viewerId?: string },
    ) {
        const user = await this.users.findOne(query).lean<UserLean>();
        return this.sanitize(user, options);
    }

    async getByNickName(nickName: string, viewerId?: string) {
        const user = await this.getByQuery(
            { nick_name: nickName },
            { viewerId },
        );
        if (!user) {
            throw new NotFoundException('User not found');
        }
        return user;
    }

    async getUsers(params: {
        nick_name?: string;
        email?: string;
        role?: string;
        is_verified?: string;
        _id?: string | string[];
        viewerId?: string;
    }) {
        const query: Record<string, unknown> = {};

        if (params.nick_name) {
            query.nick_name = params.nick_name;
        }
        if (params.email) {
            query.email = params.email;
        }
        if (params.role) {
            query.role = params.role;
        }
        if (params.is_verified) {
            query.is_verified = params.is_verified;
        }
        if (params._id !== undefined) {
            const ids = (Array.isArray(params._id) ? params._id : [params._id])
                .map(String)
                .filter(Boolean);
            query._id = { $in: ids };
        }

        const users = await this.users.find(query).lean<UserLean[]>();
        return users.map((user) =>
            this.sanitize(user, { viewerId: params.viewerId })!,
        );
    }

    async follow(userId: string, actor: Actor) {
        const followed = await this.users.findById(userId).lean<UserLean>();
        const follower = await this.users.findById(actor.id).lean<UserLean>();
        if (!followed || !follower) {
            throw new NotFoundException('User not found');
        }
        if (String(follower._id) === String(followed._id)) {
            throw new ConflictException('You cannot follow yourself!');
        }
        if (
            follower.follows.some(
                (item) => String(item) === String(followed._id),
            )
        ) {
            throw new ConflictException('You are already following this user!');
        }

        await this.notificationsService.sendNotification(
            followed._id.toString(),
            {
                type: 'follow',
                user: actor.id,
            },
        );

        const followedDoc = await this.users
            .findByIdAndUpdate(
                followed._id,
                { $addToSet: { followers: follower._id } },
                { returnDocument: 'after' },
            )
            .lean<UserLean>();
        const followerDoc = await this.users
            .findByIdAndUpdate(
                follower._id,
                { $addToSet: { follows: followed._id } },
                { returnDocument: 'after' },
            )
            .lean<UserLean>();

        await this.logger.action('follow_user', actor, {
            target_user: String(followed._id),
            target_nick: followed.nick_name,
        });
        return {
            follower: this.sanitize(followerDoc),
            followed: this.sanitize(followedDoc),
        };
    }

    async unfollow(userId: string, actor: Actor) {
        const followed = await this.users.findById(userId).lean<UserLean>();
        const follower = await this.users.findById(actor.id).lean<UserLean>();
        if (!followed || !follower) {
            throw new NotFoundException('User not found');
        }
        if (String(follower._id) === String(followed._id)) {
            throw new ConflictException('You cannot unfollow yourself!');
        }
        if (
            !follower.follows.some(
                (item) => String(item) === String(followed._id),
            )
        ) {
            throw new ConflictException('You are not following this user!');
        }

        const followedDoc = await this.users
            .findByIdAndUpdate(
                followed._id,
                { $pull: { followers: follower._id } },
                { returnDocument: 'after' },
            )
            .lean<UserLean>();
        const followerDoc = await this.users
            .findByIdAndUpdate(
                follower._id,
                { $pull: { follows: followed._id } },
                { returnDocument: 'after' },
            )
            .lean<UserLean>();

        await this.logger.action('unfollow_user', actor, {
            target_user: String(followed._id),
            target_nick: followed.nick_name,
        });
        return {
            follower: this.sanitize(followerDoc),
            followed: this.sanitize(followedDoc),
        };
    }

    async updateRole(userId: string, newRole: Role, actor: Actor) {
        const user = await this.users.findById(userId).lean<UserLean>();
        if (!user) {
            throw new NotFoundException('User not found');
        }
        if (!canManageRole(actor.role, newRole, user.role)) {
            throw new ForbiddenException(
                "You do not have permission to update this user's role",
            );
        }
        if (user.role === newRole) {
            throw new ConflictException('User already has this role');
        }

        const result = await this.users
            .findByIdAndUpdate(
                user._id,
                { role: newRole },
                { returnDocument: 'after' },
            )
            .lean<UserLean>();
        await this.sessions.deleteMany({
            $or: [{ user: user._id }, { user: String(user._id) }],
        });
        await this.logger.action(
            'update_role',
            actor,
            {
                updated_user: new Types.ObjectId(userId),
                target_nick: user.nick_name,
                old_role: user.role,
                new_role: newRole,
            },
            `User ${actor.nick_name} updated role for user ${userId}`,
        );
        return this.sanitize(result);
    }

    async create(data: {
        nick_name: string;
        password: string;
        email: string;
        description?: string;
    }) {
        const created = await this.users.create({
            ...data,
            role: DEFAULT_ROLE,
            last_activity_at: new Date(),
            is_last_activity_public: true,
        });
        return this.sanitize(created.toObject() as UserLean);
    }

    async updateById(id: string, fields: Record<string, unknown>) {
        const result = await this.users
            .findByIdAndUpdate(
                id,
                { $set: fields },
                { returnDocument: 'after' },
            )
            .lean<UserLean>();
        return this.sanitize(result, {
            withNotifications: true,
            withSavedPosts: true,
            viewerId: id,
        });
    }

    async findByEmailInsensitive(
        email: string,
        options?: { withPassword?: boolean },
    ) {
        const escaped = String(email).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const user = await this.users
            .findOne({
                email: { $regex: `^${escaped}$`, $options: 'i' },
            })
            .lean<UserLean>();
        return this.sanitize(user, options);
    }

    async deleteSessions(userId: string) {
        await this.sessions.deleteMany({
            $or: [{ user: userId }, { user: new Types.ObjectId(userId) }],
        });
    }

    async markNotificationsRead(id: string) {
        return this.users
            .findByIdAndUpdate(
                id,
                { $set: { 'notifications.$[].is_read': true } },
                { returnDocument: 'after' },
            )
            .lean();
    }

    async getPublicByIds(ids: unknown[]) {
        const objectIds = ids
            .map((id) => String(id))
            .filter((id) => Types.ObjectId.isValid(id))
            .map((id) => new Types.ObjectId(id));
        if (!objectIds.length) {
            return [];
        }
        return this.users
            .find({ _id: { $in: objectIds } })
            .select('_id nick_name avatar is_verified')
            .lean();
    }

    async removeNotifications(filter: Record<string, unknown>) {
        return this.users.updateMany({}, { $pull: { notifications: filter } });
    }

    async addSavedPost(userId: string, postId: string) {
        return this.users
            .findByIdAndUpdate(
                userId,
                { $addToSet: { saved_posts: postId } },
                { returnDocument: 'after' },
            )
            .lean<UserLean>();
    }

    async removeSavedPost(userId: string, postId: string) {
        return this.users
            .findByIdAndUpdate(
                userId,
                { $pull: { saved_posts: postId } },
                { returnDocument: 'after' },
            )
            .lean<UserLean>();
    }

    async removePostFromSavedForUsers(postId: string) {
        return this.users.updateMany(
            { saved_posts: postId },
            { $pull: { saved_posts: postId } },
        );
    }
}
