import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'logs' })
export class AppLog {
    @Prop({ required: true, default: Date.now })
    date_time!: Date;

    @Prop({ required: true })
    type!: string;

    @Prop({ required: true })
    message!: string;

    @Prop({ type: String, enum: ['info', 'warn', 'error'], default: 'info' })
    level!: 'info' | 'warn' | 'error';

    @Prop({ type: Object, default: null })
    data?: Record<string, unknown> | null;
}

export type AppLogDocument = HydratedDocument<AppLog>;
export const AppLogSchema = SchemaFactory.createForClass(AppLog);
AppLogSchema.index({ date_time: -1 });
AppLogSchema.index({ level: 1, date_time: -1 });
AppLogSchema.index({ type: 1, date_time: -1 });
AppLogSchema.index({ 'data.user': 1, date_time: -1 });
AppLogSchema.index({ 'data.post': 1, date_time: -1 });
AppLogSchema.index({ 'data.request.id': 1 });

export const DIAGNOSTIC_LOG_TYPES = [
    'slow_request',
    'slow_query',
    'login_failed',
    'rate_limited',
    'access_denied',
    'external_failed',
];
const DAY_SECONDS = 24 * 60 * 60;
const DIAGNOSTIC_TTL_SECONDS = 60 * DAY_SECONDS;
export const SERVER_ERROR_LOG_TYPES = ['server_error'];
export const NOISE_LOG_TYPES = [
    'unlike_post',
    'save_post',
    'unsave_post',
    'like_comment',
    'unlike_comment',
    'follow_user',
    'unfollow_user',
];
export const LIKE_LOG_TYPES = ['like_post'];
AppLogSchema.index(
    { date_time: 1 },
    {
        name: 'server_error_ttl',
        expireAfterSeconds: 60 * DAY_SECONDS,
        partialFilterExpression: { type: { $in: SERVER_ERROR_LOG_TYPES } },
    },
);
AppLogSchema.index(
    { date_time: 1 },
    {
        name: 'noise_ttl',
        expireAfterSeconds: 30 * DAY_SECONDS,
        partialFilterExpression: { type: { $in: NOISE_LOG_TYPES } },
    },
);
AppLogSchema.index(
    { date_time: 1 },
    {
        name: 'like_ttl',
        expireAfterSeconds: 90 * DAY_SECONDS,
        partialFilterExpression: { type: { $in: LIKE_LOG_TYPES } },
    },
);
AppLogSchema.index(
    { date_time: 1 },
    {
        name: 'diagnostic_ttl',
        expireAfterSeconds: DIAGNOSTIC_TTL_SECONDS,
        partialFilterExpression: { type: { $in: DIAGNOSTIC_LOG_TYPES } },
    },
);
