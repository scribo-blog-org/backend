import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import webpush from 'web-push';

import { PushSubscription } from '../../database/schemas/push-subscription.schema';

export type PushPayload = {
    title: string;
    body: string;
    url: string;
    tag?: string;
    icon?: string;
};

export type DismissPayload = {
    dismiss: true;
    tag?: string;
    tagPrefix?: string;
};

export type SubscriptionInput = {
    endpoint: string;
    keys: { p256dh: string; auth: string };
};

@Injectable()
export class PushService {
    private readonly logger = new Logger(PushService.name);
    private readonly publicKey: string;
    private readonly enabled: boolean;
    private readonly origin: string;

    constructor(
        @InjectModel(PushSubscription.name)
        private readonly subscriptions: Model<PushSubscription>,
        config: ConfigService,
    ) {
        this.origin = (
            config.get<string>('API_ORIGIN')?.trim() ||
            config.get<string>('FRONTEND_ORIGIN')?.trim() ||
            ''
        ).replace(/\/+$/, '');
        this.publicKey = config.get<string>('VAPID_PUBLIC_KEY')?.trim() ?? '';
        const privateKey = config.get<string>('VAPID_PRIVATE_KEY')?.trim();
        const subject =
            config.get<string>('VAPID_SUBJECT')?.trim() ||
            config.get<string>('FRONTEND_ORIGIN')?.trim();

        this.enabled = Boolean(this.publicKey && privateKey && subject);
        if (this.enabled) {
            webpush.setVapidDetails(subject!, this.publicKey, privateKey!);
        } else {
            this.logger.warn(
                'VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY or VAPID_SUBJECT is not set, push notifications are disabled',
            );
        }
    }

    // The service worker has no base for relative paths in push payloads, and
    // stored avatars are `/uploads/...` paths without a host.
    avatarUrl(value?: string | null) {
        if (!value) return undefined;
        if (/^https?:\/\//.test(value)) return value;
        if (value.startsWith('/') && this.origin) {
            return `${this.origin}${value}`;
        }
        return undefined;
    }

    getPublicKey() {
        return this.enabled ? this.publicKey : null;
    }

    async subscribe(
        userId: string,
        input: SubscriptionInput,
        userAgent?: string,
    ) {
        await this.subscriptions.findOneAndUpdate(
            { endpoint: input.endpoint },
            {
                $set: {
                    user: new Types.ObjectId(userId),
                    p256dh: input.keys.p256dh,
                    auth: input.keys.auth,
                    user_agent: userAgent?.slice(0, 300),
                },
            },
            { upsert: true },
        );
    }

    async unsubscribe(userId: string, endpoint: string) {
        await this.subscriptions.deleteOne({
            endpoint,
            user: new Types.ObjectId(userId),
        });
    }

    async hasSubscription(userId: string, endpoint: string) {
        return Boolean(
            await this.subscriptions.exists({
                endpoint,
                user: new Types.ObjectId(userId),
            }),
        );
    }

    // Asks every device of the user to close notifications that are already
    // on screen, e.g. after the chat or the notification list was read.
    async dismissForUser(
        userId: string,
        target: { tag?: string; tagPrefix?: string },
    ) {
        await this.sendToUser(userId, { dismiss: true, ...target });
    }

    async sendToUser(userId: string, payload: PushPayload | DismissPayload) {
        if (!this.enabled) return;

        const rows = await this.subscriptions
            .find({ user: new Types.ObjectId(userId) })
            .lean();
        const body = JSON.stringify(payload);
        const isDismiss = 'dismiss' in payload;

        await Promise.all(
            rows.map(async (row) => {
                // iOS has to show a notification for every push and cannot
                // reliably close it again, so a dismiss would only leave a
                // blank notification there.
                if (
                    isDismiss &&
                    /iPhone|iPad|iPod/i.test(row.user_agent ?? '')
                ) {
                    return;
                }
                try {
                    await webpush.sendNotification(
                        {
                            endpoint: row.endpoint,
                            keys: { p256dh: row.p256dh, auth: row.auth },
                        },
                        body,
                        { TTL: 60 * 60 * 24 },
                    );
                } catch (error: unknown) {
                    const status = (error as { statusCode?: number })
                        .statusCode;
                    if (status === 404 || status === 410) {
                        await this.subscriptions.deleteOne({ _id: row._id });
                        return;
                    }
                    this.logger.warn(
                        `Push to ${userId} failed: ${
                            error instanceof Error ? error.message : error
                        }`,
                    );
                }
            }),
        );
    }
}
