import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';

export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type SessionDocument = HydratedDocument<Session>;

@Schema({ collection: 'sessions', timestamps: true })
export class Session {
    @Prop({
        type: MongooseSchema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true,
    })
    user!: Types.ObjectId;

    @Prop({ required: true })
    refreshTokenHash!: string;

    @Prop({ required: true, default: 'Unknown device' })
    device!: string;

    @Prop({ required: true, default: 'Unknown' })
    location!: string;

    @Prop()
    ip?: string;

    @Prop({ required: true, default: Date.now })
    lastSeen!: Date;

    @Prop({ required: true })
    expiresAt!: Date;
}

export const SessionSchema = SchemaFactory.createForClass(Session);
SessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
