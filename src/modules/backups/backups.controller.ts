import {
    BadRequestException,
    Body,
    Controller,
    Get,
    Header,
    Param,
    Post,
    Query,
    Res,
    StreamableFile,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectModel } from '@nestjs/mongoose';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import type { Model } from 'mongoose';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import { RequirePermissions } from '../../authz/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../authz/permissions';
import type { Actor } from '../../authz/policy';
import { PaginationQueryDto } from '../../http/query.dto';
import { User } from '../../database/schemas/user.schema';
import { LoggerService, type LogActor } from '../../infra/logger.service';
import { rm } from 'fs/promises';
import { BackupImportService } from './backups.import.service';
import { BackupsService } from './backups.service';
import { BackupRestoreService } from './backups.restore.service';
import { RestoreBackupDto } from './dto/restore-backup.dto';

@ApiTags('backups')
@ApiBearerAuth()
@RequirePermissions(PERMISSIONS.MANAGE_BACKUPS)
@Controller('backups')
export class BackupsController {
    constructor(
        private readonly backups: BackupsService,
        private readonly restores: BackupRestoreService,
        private readonly imports: BackupImportService,
        private readonly logger: LoggerService,
        @InjectModel(User.name) private readonly users: Model<User>,
    ) {}

    private async author(actor: Actor): Promise<LogActor> {
        const user = await this.users
            .findById(actor.id)
            .select('avatar')
            .lean()
            .catch(() => null);
        return {
            id: actor.id,
            nick_name: actor.nick_name,
            role: actor.role,
            avatar: user?.avatar ?? null,
        };
    }

    @Get()
    async list(@Query() query: PaginationQueryDto) {
        const list = await this.backups.list(query);
        const data = {
            ...list,
            status: { ...list.status, ...(await this.restores.details()) },
        };
        return { status: true, message: 'Backups fetched successfully!', data };
    }

    @Post()
    async run(@CurrentUser() actor: Actor) {
        const author = await this.author(actor);
        const data = await this.backups.start('manual', actor.id, author);
        await this.logger.action('backup_run', author, {
            backup: String(data._id),
        });
        return { status: true, message: 'Backup started', data };
    }

    @Post(':id/restore')
    @RequirePermissions(PERMISSIONS.MANAGE_BACKUPS, PERMISSIONS.RESTORE_BACKUPS)
    async restore(
        @Param('id') id: string,
        @Body() _dto: RestoreBackupDto,
        @CurrentUser() actor: Actor,
    ) {
        const author = await this.author(actor);
        const data = await this.restores.start(id, actor.id, author);
        await this.logger.action('backup_restore', author, {
            backup: data.backup_id,
            file_name: data.file_name,
        });
        return { status: true, message: 'Restore started', data };
    }

    @Post('upload')
    @RequirePermissions(PERMISSIONS.MANAGE_BACKUPS, PERMISSIONS.RESTORE_BACKUPS)
    @UseInterceptors(FileInterceptor('file'))
    async upload(
        @UploadedFile() file: Express.Multer.File | undefined,
        @CurrentUser() actor: Actor,
    ) {
        if (!file) {
            throw new BadRequestException(
                'Attach the archive in the "file" field',
            );
        }
        const author = await this.author(actor);
        try {
            const { record: data, duplicate } = await this.imports.importFile({
                tempPath: file.path,
                originalName: file.originalname,
                size: file.size,
                userId: actor.id,
            });
            if (duplicate) {
                return {
                    status: true,
                    message: 'This backup is already in the list',
                    data: { ...data, already_listed: true },
                };
            }
            await this.logger.action('backup_upload', author, {
                backup: String(data._id),
                file_name: data.file_name,
                original_name: file.originalname,
                size_bytes: data.size_bytes,
                source_backup: data.source_id,
                app_version: data.source?.app_version ?? null,
                db_version: data.source?.db_version ?? null,
                source_db: data.source?.db_name ?? null,
            });
            return {
                status: true,
                message: 'Backup uploaded and verified',
                data,
            };
        } catch (error) {
            await this.logger.action('backup_upload_failed', author, {
                original_name: file.originalname,
                size_bytes: file.size,
                error: error instanceof Error ? error.message : String(error),
            });
            throw error;
        } finally {
            await rm(file.path, { force: true });
        }
    }

    @Get(':id/download')
    @Header('Content-Type', 'application/x-tar')
    @Header('Cache-Control', 'no-store')
    async download(
        @Param('id') id: string,
        @CurrentUser() actor: Actor,
        @Res({ passthrough: true }) res: Response,
    ) {
        const { name, size, stream } = await this.backups.openFile(id);
        await this.logger.action('backup_download', await this.author(actor), {
            backup: id,
            file_name: name,
        });
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.setHeader('Content-Length', size);
        return new StreamableFile(stream);
    }
}
