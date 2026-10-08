import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { MongooseModule } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
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
import {
    VisitDay,
    VisitDaySchema,
    VisitHour,
    VisitHourSchema,
    VisitPlace,
    VisitPlaceSchema,
    VisitUser,
    VisitUserSchema,
} from './schemas/visit-bucket.schema';
import {
    RequestMetricHour,
    RequestMetricHourSchema,
} from './schemas/request-metric.schema';
import { dbTimingPlugin } from './db-timing.plugin';
import {
    SearchQueryLog,
    SearchQueryLogSchema,
} from './schemas/search-query.schema';
import {
    Conversation,
    ConversationSchema,
} from './schemas/conversation.schema';
import { ChatMessage, ChatMessageSchema } from './schemas/chat-message.schema';
import { Backup, BackupSchema } from './schemas/backup.schema';
import {
    PushSubscription,
    PushSubscriptionSchema,
} from './schemas/push-subscription.schema';

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
                    connectionFactory: (connection: Connection) => {
                        connection.plugin(dbTimingPlugin);
                        return connection;
                    },
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
            { name: VisitDay.name, schema: VisitDaySchema },
            { name: VisitHour.name, schema: VisitHourSchema },
            { name: VisitPlace.name, schema: VisitPlaceSchema },
            { name: VisitUser.name, schema: VisitUserSchema },
            {
                name: RequestMetricHour.name,
                schema: RequestMetricHourSchema,
            },
            { name: SearchQueryLog.name, schema: SearchQueryLogSchema },
            { name: Conversation.name, schema: ConversationSchema },
            { name: ChatMessage.name, schema: ChatMessageSchema },
            { name: Backup.name, schema: BackupSchema },
            { name: PushSubscription.name, schema: PushSubscriptionSchema },
        ]),
    ],
    exports: [MongooseModule],
})
export class DatabaseModule {}
