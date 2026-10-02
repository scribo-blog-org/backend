import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { MulterModule } from '@nestjs/platform-express';
import { DatabaseModule } from '../../database/database.module';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';
import { BackupImportService } from './backups.import.service';
import { BackupRestoreService } from './backups.restore.service';
import { backupUploadOptions } from './backups.upload';
import { DbVersionService } from './db-version.service';
import { MaintenanceGuard } from './maintenance.guard';

@Module({
    imports: [
        DatabaseModule,
        MulterModule.registerAsync({
            inject: [ConfigService],
            useFactory: backupUploadOptions,
        }),
    ],
    controllers: [BackupsController],
    providers: [
        BackupsService,
        BackupRestoreService,
        BackupImportService,
        DbVersionService,
        { provide: APP_GUARD, useClass: MaintenanceGuard },
    ],
})
export class BackupsModule {}
