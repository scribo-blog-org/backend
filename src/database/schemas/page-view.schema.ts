import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

@Schema({ collection: 'pageviews' })
export class PageView {
    @Prop({ required: true, default: Date.now, index: true })
    created_at!: Date;

    @Prop({ required: true })
    path!: string;

    @Prop({ required: true, index: true })
    visitor_id!: string;

    @Prop({ type: Types.ObjectId, ref: 'User', default: null })
    user?: Types.ObjectId | null;

    @Prop({ default: '' })
    referrer?: string;

    @Prop({ default: '' })
    ip?: string;

    @Prop({ default: '' })
    city?: string;

    @Prop({ default: '' })
    region?: string;

    @Prop({ default: '' })
    country?: string;

    @Prop({ default: '' })
    device?: string;

    @Prop({ default: '' })
    device_kind?: string;

    @Prop({ required: true, default: false, index: true })
    is_entry!: boolean;
}

export type PageViewDocument = HydratedDocument<PageView>;
export const PageViewSchema = SchemaFactory.createForClass(PageView);
PageViewSchema.index({ visitor_id: 1, path: 1, created_at: -1 });
PageViewSchema.index({ visitor_id: 1, created_at: -1 });
PageViewSchema.index({ created_at: 1, path: 1 });
PageViewSchema.index({ ip: 1, created_at: -1 });
PageViewSchema.index({ city: 1, created_at: -1 });
