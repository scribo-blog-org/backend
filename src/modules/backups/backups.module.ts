import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { DatabaseModule } from '../../database/database.module';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';
import { BackupRestoreService } from './backups.restore.service';
import { MaintenanceGuard } from './maintenance.guard';

@Module({
    imports: [DatabaseModule],
    controllers: [BackupsController],
    providers: [
        BackupsService,
        BackupRestoreService,
        { provide: APP_GUARD, useClass: MaintenanceGuard },
    ],
})
export class BackupsModule {}
