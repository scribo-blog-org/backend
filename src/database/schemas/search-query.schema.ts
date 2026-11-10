import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'search_queries' })
export class SearchQueryLog {
    @Prop({ required: true, default: Date.now, index: true })
    created_at!: Date;

    @Prop({ required: true, index: true })
    query!: string;

    @Prop({ required: true, default: 'text' })
    kind!: 'hashtag' | 'text';

    @Prop({ required: true, default: 0 })
    hits!: number;

    @Prop({ required: true, default: 0 })
    posts!: number;

    @Prop({ required: true, default: 0 })
    users!: number;

    @Prop({ default: '' })
    ip?: string;
}

export type SearchQueryLogDocument = HydratedDocument<SearchQueryLog>;
export const SearchQueryLogSchema =
    SchemaFactory.createForClass(SearchQueryLog);
SearchQueryLogSchema.index({ ip: 1, query: 1, created_at: -1 });
SearchQueryLogSchema.index({ created_at: -1, kind: 1 });
