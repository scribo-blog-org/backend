import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';
import { DEFAULT_ROLE, ROLE_VALUES, type Role } from '../../authz/roles';
import { FIELD_LIMITS } from '../../validation/field-limits';
import { Notification, NotificationSchema } from './notification.schema';

export type UserDocument = HydratedDocument<User>;

@Schema({ collection: 'users' })
export class User {
    @Prop({
        required: true,
        unique: true,
        minlength: FIELD_LIMITS.nick.min,
        maxlength: FIELD_LIMITS.nick.max,
    })
    nick_name!: string;

    @Prop({ required: true })
    password!: string;

    @Prop({
        required: true,
        maxlength: FIELD_LIMITS.email.max,
        minlength: FIELD_LIMITS.email.min,
        lowercase: true,
        trim: true,
    })
    email!: string;

    @Prop({ maxlength: FIELD_LIMITS.description.max })
    description?: string;

    @Prop()
    avatar?: string;

    @Prop({ required: true, default: Date.now })
    created_date!: Date;

    @Prop({ required: true, default: Date.now })
    last_activity_at!: Date;

    @Prop({ required: true, default: false })
    is_admin!: boolean;

    @Prop({
        type: String,
        enum: ROLE_VALUES,
        default: DEFAULT_ROLE,
        required: true,
    })
    role!: Role;

    @Prop({ required: true, default: false })
    is_verified!: boolean;

    @Prop({ required: true, default: true })
    is_email_public!: boolean;

    @Prop({ required: true, default: true })
    is_saved_posts_public!: boolean;

    @Prop({ required: true, default: true })
    is_last_activity_public!: boolean;

    @Prop({ type: [{ type: Types.ObjectId, ref: 'Post' }], default: [] })
    saved_posts!: Types.ObjectId[];

    @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
    follows!: Types.ObjectId[];

    @Prop({ type: [{ type: Types.ObjectId, ref: 'User' }], default: [] })
    followers!: Types.ObjectId[];

    @Prop({
        type: [NotificationSchema],
        default: [],
    })
    notifications!: Notification[];
}

export const UserSchema = SchemaFactory.createForClass(User);
