import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument, Types } from 'mongoose';

export const BACKUP_STATUSES = ['running', 'success', 'failed'] as const;
export type BackupStatus = (typeof BACKUP_STATUSES)[number];

export const BACKUP_TRIGGERS = ['schedule', 'manual'] as const;
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

    /** День по UTC (ГГГГ-ММ-ДД). За один день хранится один файл. */
    @Prop({ type: String, required: true })
    day!: string;

    /** Имя файла внутри каталога бекапов. Путь на диске наружу не уходит. */
    @Prop({ type: String, default: null })
    file_name?: string | null;

    @Prop({ type: Number, default: null })
    size_bytes?: number | null;

    /** Когда файл удалила ротация. Запись истории при этом остаётся. */
    @Prop({ type: Date, default: null })
    file_removed_at?: Date | null;

    /** `replaced`: файл дня перезаписан новым бекапом, `rotation`: удалён по сроку. */
    @Prop({ type: String, enum: ['replaced', 'rotation'], default: null })
    file_removed_reason?: 'replaced' | 'rotation' | null;

    @Prop({ type: String, default: null })
    error?: string | null;
}

export type BackupDocument = HydratedDocument<Backup>;
export const BackupSchema = SchemaFactory.createForClass(Backup);
BackupSchema.index({ started_at: -1 });
BackupSchema.index({ day: 1, status: 1 });
