import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { AppController } from './app.controller';
import { AuthzModule } from './authz/authz.module';
import { ApiEnvelopeInterceptor } from './http/api-envelope.interceptor';
import { LastActivityInterceptor } from './http/last-activity.interceptor';
import { DatabaseModule } from './database/database.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { ProfileModule } from './modules/profile/profile.module';
import { CategoriesModule } from './modules/categories/categories.module';
import { PostsModule } from './modules/posts/posts.module';
import { FilesModule } from './files/files.module';
import { InfraModule } from './infra/infra.module';
import { SupportModule } from './modules/support/support.module';
import { LogsModule } from './modules/logs/logs.module';
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { SearchModule } from './modules/search/search.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { ChatModule } from './modules/chat/chat.module';
import { LinkPreviewModule } from './modules/link-preview/link-preview.module';
import { BackupsModule } from './modules/backups/backups.module';
import { publicKeyPem } from './config/jwt-keys';
@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        JwtModule.registerAsync({
            global: true,
            imports: [ConfigModule],
            inject: [ConfigService],
            useFactory: (config: ConfigService) => ({
                publicKey: publicKeyPem(
                    config.getOrThrow<string>('JWT_PUBLIC_KEY'),
                ),
                verifyOptions: { algorithms: ['RS256'] },
            }),
        }),
        DatabaseModule,
        FilesModule,
        InfraModule,
        AuthzModule,
        AuthModule,
        UsersModule,
        ProfileModule,
        CategoriesModule,
        PostsModule,
        SearchModule,
        SupportModule,
        LogsModule,
        AnalyticsModule,
        NotificationsModule,
        ChatModule,
        LinkPreviewModule,
        BackupsModule,
    ],
    controllers: [AppController],
    providers: [
        { provide: APP_INTERCEPTOR, useClass: ApiEnvelopeInterceptor },
        { provide: APP_INTERCEPTOR, useClass: LastActivityInterceptor },
    ],
})
export class AppModule {}
