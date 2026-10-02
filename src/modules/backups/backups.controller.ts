import {
    Body,
    Controller,
    Get,
    Header,
    Param,
    Post,
    Query,
    Res,
    StreamableFile,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import { RequirePermissions } from '../../authz/decorators/require-permissions.decorator';
import { PERMISSIONS } from '../../authz/permissions';
import type { Actor } from '../../authz/policy';
import { PaginationQueryDto } from '../../http/query.dto';
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
    ) {}

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
        const data = await this.backups.start('manual', actor.id);
        return { status: true, message: 'Backup started', data };
    }

    @Post(':id/restore')
    @RequirePermissions(PERMISSIONS.MANAGE_BACKUPS, PERMISSIONS.RESTORE_BACKUPS)
    async restore(
        @Param('id') id: string,
        @Body() _dto: RestoreBackupDto,
        @CurrentUser() actor: Actor,
    ) {
        const data = await this.restores.start(id, actor.id);
        return { status: true, message: 'Restore started', data };
    }

    @Get(':id/download')
    @Header('Content-Type', 'application/x-tar')
    @Header('Cache-Control', 'no-store')
    async download(
        @Param('id') id: string,
        @Res({ passthrough: true }) res: Response,
    ) {
        const { name, size, stream } = await this.backups.openFile(id);
        res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
        res.setHeader('Content-Length', size);
        return new StreamableFile(stream);
    }
}
