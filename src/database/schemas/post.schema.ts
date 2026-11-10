import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Schema as MongooseSchema, Types } from 'mongoose';
import type { MediaItem } from '../../modules/posts/media';
import { FIELD_LIMITS } from '../../validation/field-limits';

@Schema({ collection: 'posts' })
export class Post {
    @Prop({ type: MongooseSchema.Types.ObjectId, ref: 'User', required: true })
    author!: Types.ObjectId;

    @Prop()
    featured_image?: string;

    @Prop({ type: [Object], default: [] })
    media!: MediaItem[];

    @Prop({ default: '', maxlength: FIELD_LIMITS.postContent.max })
    content_text!: string;

    @Prop({ required: true, default: Date.now })
    created_date!: Date;

    @Prop({
        type: [{ type: MongooseSchema.Types.ObjectId, ref: 'User' }],
        default: [],
    })
    likes!: Types.ObjectId[];

    @Prop({ type: Number, default: 0, min: 0 })
    views_count!: number;
}

export type PostDocument = HydratedDocument<Post>;
export const PostSchema = SchemaFactory.createForClass(Post);
