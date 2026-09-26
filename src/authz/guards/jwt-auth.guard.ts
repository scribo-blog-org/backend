import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import {
    IS_OPTIONAL_AUTH_KEY,
    IS_PUBLIC_KEY,
} from '../decorators/public.decorator';
import { ROLE_MANAGEMENT } from '../role-management';
import { ROLE_PERMISSIONS } from '../role-permissions';
import { ROLE_VALUES, type Role } from '../roles';
import type { Actor } from '../policy';
import { publicKeyPem } from '../../common/jwt-keys';

type JwtPayload = {
    id?: string;
    user_id?: string;
    email?: string;
    role?: Role;
    nick_name?: string;
    sessionId?: string;
    tokenType?: string;
    typ?: string;
};

@Injectable()
export class JwtAuthGuard implements CanActivate {
    constructor(
        private readonly reflector: Reflector,
        private readonly jwtService: JwtService,
        private readonly config: ConfigService,
    ) {}

    canActivate(context: ExecutionContext) {
        const isPublic = this.reflector.getAllAndOverride<boolean>(
            IS_PUBLIC_KEY,
            [context.getHandler(), context.getClass()],
        );
        const isOptional = this.reflector.getAllAndOverride<boolean>(
            IS_OPTIONAL_AUTH_KEY,
            [context.getHandler(), context.getClass()],
        );

        const request = context.switchToHttp().getRequest<{
            headers: { authorization?: string };
            auth?: Actor;
            profile?: Record<string, unknown>;
        }>();

        const header = request.headers.authorization;
        const token = header?.startsWith('Bearer ') ? header.slice(7) : null;

        if (!token) {
            if (isPublic || isOptional) {
                return true;
            }
            throw new UnauthorizedException('Unauthorized');
        }

        const actor = this.decodeAccess(token);

        if (!actor) {
            if (isPublic || isOptional) {
                return true;
            }
            throw new UnauthorizedException('Unauthorized');
        }

        request.auth = actor;
        request.profile = {
            _id: actor.id,
            email: actor.email,
            nick_name: actor.nick_name,
            role: actor.role,
            permissions: ROLE_PERMISSIONS[actor.role] ?? [],
            ...(ROLE_MANAGEMENT[actor.role]
                ? { role_management: ROLE_MANAGEMENT[actor.role] }
                : {}),
        };

        return true;
    }

    private decodeAccess(token: string): Actor | null {
        try {
            const decoded = this.jwtService.verify<JwtPayload>(token, {
                publicKey: publicKeyPem(
                    this.config.getOrThrow<string>('JWT_PUBLIC_KEY'),
                ),
                algorithms: ['RS256'],
            });

            if (decoded.tokenType === 'refresh' || decoded.typ === 'refresh') {
                return null;
            }

            const id = decoded.id || decoded.user_id;
            if (!id || !decoded.role || !ROLE_VALUES.includes(decoded.role)) {
                return null;
            }

            return {
                id: String(id),
                email: decoded.email || null,
                role: decoded.role,
                nick_name: decoded.nick_name || null,
                sessionId: decoded.sessionId ? String(decoded.sessionId) : null,
            };
        } catch {
            return null;
        }
    }
}
