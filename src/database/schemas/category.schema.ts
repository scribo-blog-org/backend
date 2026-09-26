import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';
import { FIELD_LIMITS } from '../../validation/field-limits';

@Schema({ collection: 'categories' })
export class Category {
    @Prop({
        required: true,
        minlength: FIELD_LIMITS.categoryName.min,
        maxlength: FIELD_LIMITS.categoryName.max,
    })
    name!: string;

    @Prop({ type: Number, default: null })
    icon!: number | null;

    @Prop({ type: Number, default: null })
    color!: number | null;
}

export type CategoryDocument = HydratedDocument<Category>;
export const CategorySchema = SchemaFactory.createForClass(Category);
