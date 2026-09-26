import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { extractMentionNicks, newMentionNicks } from './mentions.util';
import { User } from '../../database/schemas/user.schema';
import { NotificationsService } from './notifications.service';
import type { NotificationType } from './notifications.type';

type MentionContext = {
    actorId: string;
    text: string;
    postId: string;
    commentId?: string;
    excludeUserIds?: Iterable<string>;
};

@Injectable()
export class MentionNotificationsService {
    private readonly logger = new Logger(MentionNotificationsService.name);

    constructor(
        @InjectModel(User.name) private readonly users: Model<User>,
        private readonly notifications: NotificationsService,
    ) {}

    async resolveMentionedUserIds(text: string) {
        const users = await this.findUsersByMentionNicks(
            extractMentionNicks(text),
        );
        return new Set(users.map((user) => String(user._id)));
    }

    async notifyFromText(context: MentionContext) {
        await this.notifyNicks(extractMentionNicks(context.text), context);
    }

    async notifyNewMentions(
        previousText: string,
        nextText: string,
        context: Omit<MentionContext, 'text'>,
    ) {
        await this.notifyNicks(newMentionNicks(previousText, nextText), {
            ...context,
            text: nextText,
        });
    }

    private escapeRegex(value: string) {
        return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    private async findUsersByMentionNicks(nicks: string[]) {
        if (!nicks.length) {
            return [];
        }

        return this.users
            .find({
                $or: nicks.map((nick) => ({
                    nick_name: new RegExp(`^${this.escapeRegex(nick)}$`, 'i'),
                })),
            })
            .select('_id nick_name')
            .lean<{ _id: unknown; nick_name: string }[]>();
    }

    private async notifyNicks(nicks: string[], context: MentionContext) {
        if (!nicks.length) {
            return;
        }

        const excluded = new Set(
            [context.actorId, ...(context.excludeUserIds || [])].map(String),
        );
        const mentionedUsers = await this.findUsersByMentionNicks(nicks);

        const type: NotificationType = context.commentId
            ? 'mention_comment'
            : 'mention_post';

        for (const user of mentionedUsers) {
            const userId = String(user._id);
            if (excluded.has(userId)) {
                continue;
            }
            excluded.add(userId);

            try {
                await this.notifications.sendNotification(userId, {
                    type,
                    user: context.actorId,
                    post: context.postId,
                    ...(context.commentId
                        ? { comment: context.commentId }
                        : {}),
                });
            } catch (error) {
                this.logger.error(
                    `Failed to send ${type} notification to ${userId}`,
                    error instanceof Error ? error.stack : String(error),
                );
            }
        }
    }
}
