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

const PLACE_TTL_SECONDS = 70 * 24 * 60 * 60;

@Schema({ collection: 'visit_places' })
export class VisitPlace {
    @Prop({ required: true })
    hour!: string;

    @Prop({ required: true })
    bucket_at!: Date;

    @Prop({ required: true, default: '' })
    city!: string;

    @Prop({ required: true, default: '' })
    country!: string;

    @Prop({ required: true, default: 0 })
    count!: number;
}

export type VisitPlaceDocument = HydratedDocument<VisitPlace>;
export const VisitPlaceSchema = SchemaFactory.createForClass(VisitPlace);
VisitPlaceSchema.index({ hour: 1, city: 1, country: 1 }, { unique: true });
VisitPlaceSchema.index(
    { bucket_at: 1 },
    { expireAfterSeconds: PLACE_TTL_SECONDS },
);

@Schema({ collection: 'visit_users' })
export class VisitUser {
    @Prop({ required: true })
    hour!: string;

    @Prop({ required: true })
    bucket_at!: Date;

    @Prop({ required: true })
    user!: string;
}

export type VisitUserDocument = HydratedDocument<VisitUser>;
export const VisitUserSchema = SchemaFactory.createForClass(VisitUser);
VisitUserSchema.index({ hour: 1, user: 1 }, { unique: true });
VisitUserSchema.index(
    { bucket_at: 1 },
    { expireAfterSeconds: PLACE_TTL_SECONDS },
);
