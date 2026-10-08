import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type PushSubscriptionDocument = HydratedDocument<PushSubscription>;

@Schema({ collection: 'push_subscriptions', timestamps: true })
export class PushSubscription {
    @Prop({ type: Types.ObjectId, ref: 'User', required: true, index: true })
    user!: Types.ObjectId;

    @Prop({ required: true, unique: true })
    endpoint!: string;

    @Prop({ required: true })
    p256dh!: string;

    @Prop({ required: true })
    auth!: string;

    @Prop()
    user_agent?: string;
}

export const PushSubscriptionSchema =
    SchemaFactory.createForClass(PushSubscription);
