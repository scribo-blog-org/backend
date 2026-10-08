import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { SocketService } from '../../socket/socket.service';
import { PushService } from '../push/push.service';
import { User } from '../../database/schemas/user.schema';

import type {
    CreateNotification,
    NotificationType,
} from './notifications.type';

@Injectable()
export class NotificationsService {
    constructor(
        @InjectModel(User.name) private readonly users: Model<User>,
        private readonly socketService: SocketService,
        private readonly push: PushService,
    ) {}

    async sendNotification(userId: string, notification: CreateNotification) {
        const notificationUpdate = await this.users.findByIdAndUpdate(
            userId,
            {
                $push: {
                    notifications: {
                        is_read: false,
                        time: new Date(),
                        ...notification,
                    },
                },
            },
            { returnDocument: 'after', runValidators: true },
        );

        if (notificationUpdate) {
            this.socketService.userNotification(
                String(userId),
                notificationUpdate.notifications,
            );
            void this.pushNotification(String(userId), notification).catch(
                () => undefined,
            );
        }
    }

    async dismissPushNotifications(userId: string) {
        await this.push
            .dismissForUser(userId, { tagPrefix: 'notification:' })
            .catch(() => undefined);
    }

    private async pushNotification(
        userId: string,
        notification: CreateNotification,
    ) {
        const actor = notification.user
            ? await this.users
                  .findById(notification.user, 'nick_name avatar')
                  .lean<{ nick_name?: string; avatar?: string }>()
            : null;
        const who = actor?.nick_name || 'Someone';

        const byType: Record<NotificationType, { body: string; url: string }> =
            {
                follow: { body: `${who} followed you`, url: '/notifications' },
                like_post: {
                    body: `${who} liked your post`,
                    url: '/notifications',
                },
                comment_post: {
                    body: `${who} commented on your post`,
                    url: '/notifications',
                },
                reply_comment: {
                    body: `${who} replied to your comment`,
                    url: '/notifications',
                },
                mention_post: {
                    body: `${who} mentioned you in a post`,
                    url: '/notifications',
                },
                mention_comment: {
                    body: `${who} mentioned you in a comment`,
                    url: '/notifications',
                },
                support_reply: {
                    body: 'A new reply to your request',
                    url: '/notifications',
                },
                support_status: {
                    body: `Status of your request: ${notification.support_status ?? 'updated'}`,
                    url: '/notifications',
                },
            };

        const entry = byType[notification.type];
        if (!entry) return;

        await this.push.sendToUser(userId, {
            title: 'Scribo',
            body: entry.body,
            url: entry.url,
            tag: `notification:${notification.type}`,
            // Support replies are sent in the team's name, not the staff member's.
            icon: notification.type.startsWith('support_')
                ? undefined
                : this.push.avatarUrl(actor?.avatar),
        });
    }
}
