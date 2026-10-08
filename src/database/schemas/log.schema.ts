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
