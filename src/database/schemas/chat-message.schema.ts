import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { FIELD_LIMITS } from '../../validation/field-limits';

export type ChatMessageDocument = HydratedDocument<ChatMessage>;

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

    @Prop({
        required: true,
        minlength: FIELD_LIMITS.chatMessage.min,
        maxlength: FIELD_LIMITS.chatMessage.max,
    })
    text!: string;

    @Prop({ type: Types.ObjectId, ref: 'ChatMessage', default: null })
    reply_to?: Types.ObjectId | null;

    @Prop({ type: Date, default: null })
    deleted_at?: Date | null;

    @Prop({ type: Date, default: null })
    edited_at?: Date | null;
}

export const ChatMessageSchema = SchemaFactory.createForClass(ChatMessage);
ChatMessageSchema.index({ conversation_id: 1, createdAt: -1 });
