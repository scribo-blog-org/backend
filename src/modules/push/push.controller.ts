import {
    Body,
    Controller,
    Delete,
    Get,
    Headers,
    Post,
    Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../authz/decorators/current-user.decorator';
import type { Actor } from '../../authz/policy';
import { PushSubscribeDto, PushUnsubscribeDto } from './dto/push.dto';
import { PushService } from './push.service';

@ApiTags('push')
@ApiBearerAuth()
@Controller('push')
export class PushController {
    constructor(private readonly push: PushService) {}

    @Get('key')
    key() {
        return {
            status: true,
            message: 'Push key fetched',
            data: { publicKey: this.push.getPublicKey() },
        };
    }

    @Get('subscription')
    async subscription(
        @CurrentUser() actor: Actor,
        @Query('endpoint') endpoint?: string,
    ) {
        const subscribed = endpoint
            ? await this.push.hasSubscription(actor.id, endpoint)
            : false;
        return {
            status: true,
            message: 'Push subscription checked',
            data: { subscribed },
        };
    }

    @Post('subscription')
    async subscribe(
        @CurrentUser() actor: Actor,
        @Body() dto: PushSubscribeDto,
        @Headers('user-agent') userAgent?: string,
    ) {
        await this.push.subscribe(actor.id, dto, userAgent);
        return { status: true, message: 'Push subscribed', data: true };
    }

    @Delete('subscription')
    async unsubscribe(
        @CurrentUser() actor: Actor,
        @Body() dto: PushUnsubscribeDto,
    ) {
        await this.push.unsubscribe(actor.id, dto.endpoint);
        return { status: true, message: 'Push unsubscribed', data: true };
    }
}
