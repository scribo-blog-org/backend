import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { LoggerService } from './logger.service';
import { MailService } from './mail.service';
import { StartupService } from './startup.service';
import { StorageService } from './storage.service';

@Global()
@Module({
    imports: [DatabaseModule],
    providers: [MailService, StorageService, LoggerService, StartupService],
    exports: [MailService, StorageService, LoggerService, StartupService],
})
export class InfraModule {}
