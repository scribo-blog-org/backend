import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const EVENTS_CHANNEL = 'scribo:events';

export function encodeBusEvent(
    room: string,
    event: string,
    payload: unknown,
): string {
    return JSON.stringify({ room, event, payload });
}

@Injectable()
export class RedisPublisher implements OnModuleDestroy {
    private readonly logger = new Logger(RedisPublisher.name);
    private readonly client: Redis;

    constructor(config: ConfigService) {
        this.client = new Redis(config.getOrThrow<string>('REDIS_URL'), {
            maxRetriesPerRequest: 3,
        });
        this.client.on('error', (error: Error) => {
            this.logger.error(error.message);
        });
    }

    async publish(
        room: string,
        event: string,
        payload: unknown,
    ): Promise<void> {
        await this.client.publish(
            EVENTS_CHANNEL,
            encodeBusEvent(room, event, payload),
        );
    }

    async onModuleDestroy() {
        await this.client.quit();
    }
}
