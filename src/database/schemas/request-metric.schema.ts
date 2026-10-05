import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

const METRIC_TTL_SECONDS = 70 * 24 * 60 * 60;

@Schema({ collection: 'request_metric_hours' })
export class RequestMetricHour {
    @Prop({ required: true })
    hour!: string;

    @Prop({ required: true })
    bucket_at!: Date;

    @Prop({ required: true })
    route!: string;

    @Prop({ required: true, default: 0 })
    count!: number;

    @Prop({ required: true, default: 0 })
    total_ms!: number;

    @Prop({ required: true, default: 0 })
    db_ms!: number;

    @Prop({ required: true, default: 0 })
    max_ms!: number;

    @Prop({ type: Object, default: {} })
    h!: Record<string, number>;
}

export type RequestMetricHourDocument = HydratedDocument<RequestMetricHour>;
export const RequestMetricHourSchema =
    SchemaFactory.createForClass(RequestMetricHour);
RequestMetricHourSchema.index({ hour: 1, route: 1 }, { unique: true });
RequestMetricHourSchema.index(
    { bucket_at: 1 },
    { expireAfterSeconds: METRIC_TTL_SECONDS },
);
