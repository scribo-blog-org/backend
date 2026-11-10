import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import { FIELD_LIMITS } from '../../validation/field-limits';

@Schema({ collection: 'post_comments' })
export class PostComment {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
    author!: Types.ObjectId;

    @Prop({
        required: true,
        minlength: FIELD_LIMITS.comment.min,
        maxlength: FIELD_LIMITS.comment.max,
    })
    comment_text!: string;

    @Prop({
        type: MongooseSchema.Types.ObjectId,
        ref: 'Post',
        required: true,
        index: true,
    })
    post_id!: Types.ObjectId;

    @Prop({ required: true, default: Date.now })
    created_date!: Date;

    @Prop({ type: MongooseSchema.Types.ObjectId, default: null, index: true })
    parent_comment_id!: Types.ObjectId | null;

    @Prop({
        type: [{ type: MongooseSchema.Types.ObjectId, ref: 'User' }],
        default: [],
    })
    likes!: Types.ObjectId[];
}

export type PostCommentDocument = HydratedDocument<PostComment>;
export const PostCommentSchema = SchemaFactory.createForClass(PostComment);
