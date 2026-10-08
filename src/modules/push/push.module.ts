import { Module } from '@nestjs/common';

import { DatabaseModule } from '../../database/database.module';
import { PushController } from './push.controller';
import { PushService } from './push.service';

@Module({
    imports: [DatabaseModule],
    controllers: [PushController],
    providers: [PushService],
    exports: [PushService],
})
export class PushModule {}
