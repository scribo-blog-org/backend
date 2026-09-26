import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { FIELD_LIMITS } from '../../validation/field-limits';

@Schema({ collection: 'posts' })
export class Post {
    @Prop({ type: Types.ObjectId, ref: 'User', required: true })
    author!: Types.ObjectId;

    @Prop({
        required: true,
        minlength: FIELD_LIMITS.postTitle.min,
        maxlength: FIELD_LIMITS.postTitle.max,
    })
    title!: string;

    @Prop()
    featured_image?: string;

    @Prop({
        required: true,
        minlength: FIELD_LIMITS.postContent.min,
        maxlength: FIELD_LIMITS.postContent.max,
    })
    content_text!: string;

    @Prop({ type: Types.ObjectId, ref: 'Category', required: true })
    category!: Types.ObjectId;

    @Prop({ required: true, default: Date.now })
    created_date!: Date;

    @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
    likes!: Types.ObjectId[];

    @Prop({ type: Number, default: 0, min: 0 })
    views_count!: number;
}

export type PostDocument = HydratedDocument<Post>;
export const PostSchema = SchemaFactory.createForClass(Post);
