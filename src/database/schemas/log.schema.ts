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

// Diagnostics are noisy by nature and only useful while fresh, so they expire.
// Audit events (posts, roles, backups) and server errors are kept.
export const DIAGNOSTIC_LOG_TYPES = [
    'slow_request',
    'slow_query',
    'login_failed',
    'rate_limited',
    'access_denied',
    'external_failed',
];
const DIAGNOSTIC_TTL_SECONDS = 60 * 24 * 60 * 60;
AppLogSchema.index(
    { date_time: 1 },
    {
        name: 'diagnostic_ttl',
        expireAfterSeconds: DIAGNOSTIC_TTL_SECONDS,
        partialFilterExpression: { type: { $in: DIAGNOSTIC_LOG_TYPES } },
    },
);
