import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { BackupsController } from './backups.controller';
import { BackupsService } from './backups.service';

@Module({
    imports: [DatabaseModule],
    controllers: [BackupsController],
    providers: [BackupsService],
})
export class BackupsModule {}
