import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { LogsController } from './logs.controller';
import { LogsQueryService } from './logs.service';
import { RuntimeLogsService } from './runtime-logs.service';

@Module({
    imports: [DatabaseModule],
    controllers: [LogsController],
    providers: [LogsQueryService, RuntimeLogsService],
})
export class LogsModule {}
