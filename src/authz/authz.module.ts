import { Global, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RateLimitGuard } from '../http/rate-limit.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { PermissionsGuard } from './guards/permissions.guard';

@Global()
@Module({
    providers: [
        JwtAuthGuard,
        PermissionsGuard,
        RateLimitGuard,
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: PermissionsGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
    ],
    exports: [JwtAuthGuard, PermissionsGuard, RateLimitGuard],
})
export class AuthzModule {}
