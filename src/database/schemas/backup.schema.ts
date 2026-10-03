import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const BACKUP_STATUSES = ['running', 'success', 'failed'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export const BACKUP_TRIGGERS = ['schedule', 'manual', 'upload'] as const;
export type BackupTrigger = (typeof BACKUP_TRIGGERS)[number];

@Schema({ collection: 'backups' })
export class Backup {
    @Prop({
        type: String,
        required: true,
        enum: BACKUP_STATUSES,
        default: 'running',
    })
    status!: BackupStatus;

    @Prop({ type: String, required: true, enum: BACKUP_TRIGGERS })
    trigger!: BackupTrigger;

    @Prop({ type: Types.ObjectId, ref: 'User', default: null })
    triggered_by?: Types.ObjectId | null;

    @Prop({ required: true, default: Date.now })
    started_at!: Date;

    @Prop({ type: Date, default: null })
    finished_at?: Date | null;

    @Prop({
        type: String,
        enum: ['daily', 'pre_restore', 'uploaded'],
        default: 'daily',
    })
    kind!: 'daily' | 'pre_restore' | 'uploaded';

    @Prop({ type: String, default: null })
    source_id?: string | null;

    @Prop({ type: Object, default: null })
    source?: {
        created_at: string;
        app_version: string;
        db_version: string | null;
        db_name: string;
        trigger: string;
        kind: string;
        original_name: string;
    } | null;

    @Prop({ type: Object, default: null })
    contents?: {
        db_name: string;
        collections: number;
        db_bytes: number;
        uploads_files: number;
        uploads_bytes: number;
        based_on: string | null;
        app_version?: string;
        db_version?: string | null;
    } | null;

    @Prop({ type: String, required: true })
    day!: string;

    @Prop({ type: String, default: null })
    file_name?: string | null;

    @Prop({ type: Number, default: null })
    size_bytes?: number | null;

    @Prop({ type: Date, default: null })
    file_removed_at?: Date | null;

    @Prop({
        type: String,
        enum: ['replaced', 'rotation', 'restored'],
        default: null,
    })
    file_removed_reason?: 'replaced' | 'rotation' | 'restored' | null;

    @Prop({ type: String, default: null })
    error?: string | null;
}

export type BackupDocument = HydratedDocument<Backup>;
export const BackupSchema = SchemaFactory.createForClass(Backup);
BackupSchema.index({ started_at: -1 });
BackupSchema.index({ day: 1, status: 1 });
