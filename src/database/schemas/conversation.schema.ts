import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ConversationDocument = HydratedDocument<Conversation>;
export type ConversationKind = 'direct' | 'group';
export type ConversationRole = 'admin' | 'member';

@Schema({ _id: false })
export class ConversationMember {
    @Prop({ type: Types.ObjectId, ref: 'User', required: true })
    user_id!: Types.ObjectId;

    @Prop({ required: true, enum: ['admin', 'member'], default: 'member' })
    role!: ConversationRole;
}

export const ConversationMemberSchema =
    SchemaFactory.createForClass(ConversationMember);

@Schema({ collection: 'conversations', timestamps: true })
export class Conversation {
    @Prop({ required: true, unique: true, index: true })
    participant_key!: string;

    @Prop({ enum: ['direct', 'group'], default: 'direct' })
    kind!: ConversationKind;

    @Prop({ default: '' })
    title!: string;

    @Prop({ default: '' })
    description!: string;

    @Prop({ type: String, default: null })
    photo?: string | null;

    @Prop({ type: [Types.ObjectId], ref: 'User', required: true })
    participants!: Types.ObjectId[];

    @Prop({ type: [ConversationMemberSchema], default: [] })
    members!: ConversationMember[];

    @Prop({ type: Types.ObjectId, ref: 'ChatMessage', default: null })
    last_message_id?: Types.ObjectId | null;

    @Prop({ default: '' })
    last_message_text!: string;

    @Prop({ default: '' })
    last_message_sender_name!: string;

    @Prop({ type: Date, default: null })
    last_message_at?: Date | null;

    @Prop({ type: Object, default: {} })
    last_read_at!: Record<string, Date>;
}

export const ConversationSchema = SchemaFactory.createForClass(Conversation);
ConversationSchema.index({ participants: 1, last_message_at: -1 });
