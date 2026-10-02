import {
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

@ApiTags('backups')
@ApiBearerAuth()
@RequirePermissions(PERMISSIONS.MANAGE_BACKUPS)
@Controller('backups')
export class BackupsController {
    constructor(private readonly backups: BackupsService) {}

    @Get()
    async list(@Query() query: PaginationQueryDto) {
        const data = await this.backups.list(query);
        return { status: true, message: 'Backups fetched successfully!', data };
    }

    @Post()
    async run(@CurrentUser() actor: Actor) {
        const data = await this.backups.start('manual', actor.id);
        return { status: true, message: 'Backup started', data };
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
