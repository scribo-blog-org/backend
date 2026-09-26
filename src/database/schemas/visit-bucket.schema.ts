import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

@Schema({ collection: 'visit_days' })
export class VisitDay {
    @Prop({ required: true, unique: true })
    day!: string;

    @Prop({ required: true, default: 0 })
    authorized!: number;

    @Prop({ required: true, default: 0 })
    anonymous!: number;

    @Prop({ default: 0 })
    imported_authorized!: number;

    @Prop({ default: 0 })
    imported_anonymous!: number;
}

export type VisitDayDocument = HydratedDocument<VisitDay>;
export const VisitDaySchema = SchemaFactory.createForClass(VisitDay);

const HOUR_TTL_SECONDS = 24 * 60 * 60;

@Schema({ collection: 'visit_hours' })
export class VisitHour {
    @Prop({ required: true, unique: true })
    hour!: string;

    @Prop({ required: true })
    bucket_at!: Date;

    @Prop({ required: true, default: 0 })
    authorized!: number;

    @Prop({ required: true, default: 0 })
    anonymous!: number;

    @Prop({ default: 0 })
    imported_authorized!: number;

    @Prop({ default: 0 })
    imported_anonymous!: number;
}

export type VisitHourDocument = HydratedDocument<VisitHour>;
export const VisitHourSchema = SchemaFactory.createForClass(VisitHour);
VisitHourSchema.index(
    { bucket_at: 1 },
    { expireAfterSeconds: HOUR_TTL_SECONDS },
);
