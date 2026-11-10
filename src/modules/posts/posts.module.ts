import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { InfraModule } from '../../infra/infra.module';
import { UsersModule } from '../users/users.module';
import { LinkPreviewModule } from '../link-preview/link-preview.module';
import { MediaService } from './media';
import { CommentsController } from './comments.controller';
import { CommentsService } from './comments.service';
import { PostsController } from './posts.controller';
import { PostsService } from './posts.service';
import { NotificationsModule } from '../notifications/notifications.module';

@Module({
    imports: [
        DatabaseModule,
        InfraModule,
        UsersModule,
        NotificationsModule,
        LinkPreviewModule,
    ],
    controllers: [PostsController, CommentsController],
    providers: [PostsService, CommentsService, MediaService],
})
export class PostsModule {}
