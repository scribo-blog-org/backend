import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import { mongoUri } from '../config/startup';
import { Session, SessionSchema } from './schemas/session.schema';
import { User, UserSchema } from './schemas/user.schema';
import {
    EmailVerificationCode,
    EmailVerificationCodeSchema,
} from './schemas/email-verification.schema';
import { Category, CategorySchema } from './schemas/category.schema';
import { Post, PostSchema } from './schemas/post.schema';
import { PostComment, PostCommentSchema } from './schemas/post-comment.schema';
import {
    SupportRequest,
    SupportRequestSchema,
} from './schemas/support-request.schema';
import { AppLog, AppLogSchema } from './schemas/log.schema';
import { PageView, PageViewSchema } from './schemas/page-view.schema';
import {
    SearchQueryLog,
    SearchQueryLogSchema,
} from './schemas/search-query.schema';
import {
    Conversation,
    ConversationSchema,
} from './schemas/conversation.schema';
import { ChatMessage, ChatMessageSchema } from './schemas/chat-message.schema';

@Module({
    imports: [
        MongooseModule.forRootAsync({
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => {
                const uri = mongoUri(config);
                return {
                    uri,
                    retryAttempts: 0,
                    serverSelectionTimeoutMS: 8000,
                    connectTimeoutMS: 8000,
                    socketTimeoutMS: 10000,
                    bufferCommands: false,
                };
            },
        }),
        MongooseModule.forFeature([
            { name: User.name, schema: UserSchema },
            { name: Session.name, schema: SessionSchema },
            {
                name: EmailVerificationCode.name,
                schema: EmailVerificationCodeSchema,
            },
            { name: Category.name, schema: CategorySchema },
            { name: Post.name, schema: PostSchema },
            { name: PostComment.name, schema: PostCommentSchema },
            { name: SupportRequest.name, schema: SupportRequestSchema },
            { name: AppLog.name, schema: AppLogSchema },
            { name: PageView.name, schema: PageViewSchema },
            { name: SearchQueryLog.name, schema: SearchQueryLogSchema },
            { name: Conversation.name, schema: ConversationSchema },
            { name: ChatMessage.name, schema: ChatMessageSchema },
        ]),
    ],
    exports: [MongooseModule],
})
export class DatabaseModule {}
