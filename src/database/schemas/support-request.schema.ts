import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { FIELD_LIMITS } from '../../validation/field-limits';

@Schema({ collection: 'supportrequests' })
export class SupportRequest {
    @Prop({
        required: true,
        lowercase: true,
        trim: true,
        maxlength: FIELD_LIMITS.email.max,
        minlength: FIELD_LIMITS.email.min,
    })
    email!: string;

    @Prop({ required: true, enum: ['complaint', 'request', 'help'] })
    kind!: string;

    @Prop({
        required: true,
        minlength: FIELD_LIMITS.supportMessage.min,
        maxlength: FIELD_LIMITS.supportMessage.max,
    })
    message!: string;

    @Prop({
        required: true,
        enum: ['new', 'in_review', 'reviewed', 'open', 'answered'],
        default: 'new',
    })
    status!: string;

    @Prop({ unique: true, sparse: true })
    access_key?: string;

    @Prop({ required: true, default: true })
    anonymous!: boolean;

    @Prop({ type: Types.ObjectId, ref: 'User', default: null })
    user?: Types.ObjectId | null;

    @Prop({ required: true, default: Date.now })
    created_date!: Date;

    @Prop({ required: true, default: Date.now })
    updated_date!: Date;

    @Prop({ type: Array, default: [] })
    replies!: Record<string, unknown>[];
}

export type SupportRequestDocument = HydratedDocument<SupportRequest>;
export const SupportRequestSchema =
    SchemaFactory.createForClass(SupportRequest);
SupportRequestSchema.index({ status: 1, created_date: -1 });
SupportRequestSchema.index({ kind: 1, created_date: -1 });
SupportRequestSchema.index({ user: 1, created_date: -1 });
