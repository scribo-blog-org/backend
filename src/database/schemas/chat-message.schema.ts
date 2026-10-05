import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export type ChatMessageDocument = HydratedDocument<ChatMessage>;

export const CHAT_SYSTEM_EVENTS = [
    'member_joined',
    'member_added',
    'member_removed',
    'member_left',
    'group_updated',
    'admin_granted',
    'admin_revoked',
] as const;

export type ChatSystemEvent = (typeof CHAT_SYSTEM_EVENTS)[number];

@Schema({ collection: 'chat_messages', timestamps: true })
export class ChatMessage {
    @Prop({
        type: Types.ObjectId,
        ref: 'Conversation',
        required: true,
        index: true,
    })
    conversation_id!: Types.ObjectId;

    @Prop({ type: Types.ObjectId, ref: 'User', required: true })
    sender_id!: Types.ObjectId;

    // Stored encrypted; the length limits are enforced on the plain text before encryption.
    @Prop({ required: true })
    text!: string;

    @Prop({ type: Types.ObjectId, ref: 'ChatMessage', default: null })
    reply_to?: Types.ObjectId | null;

    @Prop({ type: String, enum: CHAT_SYSTEM_EVENTS, default: null })
    system_event?: ChatSystemEvent | null;

    @Prop({ type: Date, default: null })
    deleted_at?: Date | null;

    @Prop({ type: Date, default: null })
    edited_at?: Date | null;
}

export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);
ChatMessageSchema.index({ conversation_id: 1, createdAt: -1 });
