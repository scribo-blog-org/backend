import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import {
    NOTIFICATION_TYPES,
    type NotificationType,
} from '../../modules/notifications/notifications.type';

export type NotificationDocument = HydratedDocument<Notification>;

@Schema()
export class Notification {
    @Prop({ required: true, default: false })
    is_read!: boolean;

    @Prop({ required: true, default: Date.now })
    time!: Date;

    @Prop({
        type: String,
        enum: NOTIFICATION_TYPES,
        required: true,
    })
    type!: NotificationType;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User' })
    user?: Types.ObjectId;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'Post' })
    post?: Types.ObjectId;

    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'PostComment' })
    comment?: Types.ObjectId;

    @Prop({ type: String })
    support_request?: string;

    @Prop({ type: String })
    support_status?: string;
}

export const NotificationSchema = SchemaFactory.createForClass(Notification);
