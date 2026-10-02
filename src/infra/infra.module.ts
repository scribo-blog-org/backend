import { Global, Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { LoggerService } from './logger.service';
import { MailService } from './mail.service';
import { StartupService } from './startup.service';

@Global()
@Module({
    imports: [DatabaseModule],
    providers: [MailService, LoggerService, StartupService],
    exports: [MailService, LoggerService, StartupService],
})
export class InfraModule {}
