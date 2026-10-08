import { getModelToken } from '@nestjs/mongoose';
import { Test, TestingModule } from '@nestjs/testing';
import { User } from '../../database/schemas/user.schema';
import { SocketService } from '../../socket/socket.service';
import { PushService } from '../push/push.service';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
    let service: NotificationsService;

    beforeEach(async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                NotificationsService,
                { provide: getModelToken(User.name), useValue: {} },
                { provide: PushService, useValue: { sendToUser: jest.fn() } },
                {
                    provide: SocketService,
                    useValue: { userNotification: jest.fn() },
                },
            ],
        }).compile();

        service = module.get<NotificationsService>(NotificationsService);
    });

    it('should be defined', () => {
        expect(service).toBeDefined();
    });
});
