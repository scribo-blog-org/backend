import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import type { Actor } from '../authz/policy';
import { TokenService } from '../modules/auth/token.service';
import { UsersService } from '../modules/users/users.service';

@Injectable()
export class LastActivityInterceptor implements NestInterceptor {
    constructor(
        private readonly users: UsersService,
        private readonly tokens: TokenService,
    ) {}

    intercept(
        context: ExecutionContext,
        next: CallHandler,
    ): Observable<unknown> {
        if (context.getType() !== 'http') {
            return next.handle();
        }

        const request = context
            .switchToHttp()
            .getRequest<Request & { auth?: Actor }>();
        const userId = this.resolveUserId(request);
        if (userId) {
            this.users.touchLastActivity(userId);
        }

        return next.handle();
    }

    private resolveUserId(request: Request & { auth?: Actor }): string | null {
        if (request.auth?.id) {
            return request.auth.id;
        }

        const header = request.headers.authorization;
        if (typeof header === 'string' && header.startsWith('Bearer ')) {
            const id = this.tokens.identifyAccess(header.slice(7));
            return id || null;
        }

        return null;
    }
}
