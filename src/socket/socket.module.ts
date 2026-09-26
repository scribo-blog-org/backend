import { Module } from '@nestjs/common';
import { RedisPublisher } from './redis.publisher';
import { SocketEvents } from './socket.events';
import { SocketService } from './socket.service';

@Module({
    providers: [RedisPublisher, SocketEvents, SocketService],
    exports: [SocketService],
})
export class SocketModule {}
