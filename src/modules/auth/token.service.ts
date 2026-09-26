import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as jwt from 'jsonwebtoken';
import type { Role } from '../../authz/roles';
import { privateKeyFromEnv, publicKeyFromEnv } from '../../common/jwt-keys';

const ACCESS_TTL = '15m';
const REFRESH_TTL = '30d';

export type AccessUser = {
    _id: unknown;
    email: string;
    role: Role;
    nick_name: string;
};

@Injectable()
export class TokenService {
    constructor(private readonly config: ConfigService) {}

    private accessPrivateKey() {
        return privateKeyFromEnv(
            this.config.getOrThrow<string>('JWT_PRIVATE_KEY'),
        );
    }

    private accessPublicKey() {
        return publicKeyFromEnv(
            this.config.getOrThrow<string>('JWT_PUBLIC_KEY'),
        );
    }

    private refreshKey() {
        const key = this.config.get<string>('JWT_REFRESH_KEY')?.trim();
        if (!key) {
            throw new Error('Set JWT_REFRESH_KEY');
        }
        return key;
    }

    encodeAccess(user: AccessUser, sessionId?: string) {
        const payload: Record<string, string> = {
            id: String(user._id),
            email: user.email,
            role: user.role,
            nick_name: user.nick_name,
        };
        if (sessionId) {
            payload.sessionId = String(sessionId);
        }
        return jwt.sign(payload, this.accessPrivateKey(), {
            algorithm: 'RS256',
            expiresIn: ACCESS_TTL,
        });
    }

    encodeRefresh(userId: unknown, sessionId: unknown) {
        return jwt.sign(
            {
                id: String(userId),
                sessionId: String(sessionId),
                tokenType: 'refresh',
            },
            this.refreshKey(),
            { expiresIn: REFRESH_TTL },
        );
    }

    decodeRefresh(token: string) {
        const key = this.refreshKey();
        try {
            const decoded = jwt.verify(token, key) as {
                id?: string;
                sessionId?: string;
                tokenType?: string;
                typ?: string;
            };
            if (!decoded?.id || !decoded?.sessionId) return null;
            if (decoded.tokenType !== 'refresh' && decoded.typ !== 'refresh')
                return null;
            return decoded;
        } catch {
            return null;
        }
    }

    peekAccess(token: string) {
        try {
            const decoded = jwt.decode(token) as {
                id?: string;
                user_id?: string;
                email?: string;
                role?: Role;
                nick_name?: string;
                sessionId?: string;
                tokenType?: string;
                typ?: string;
            } | null;
            if (
                !decoded ||
                decoded.tokenType === 'refresh' ||
                decoded.typ === 'refresh'
            ) {
                return null;
            }
            const id = decoded.id || decoded.user_id;
            if (!id) return null;
            return {
                id: String(id),
                email: decoded.email || null,
                role: decoded.role || null,
                nick_name: decoded.nick_name || null,
                sessionId: decoded.sessionId ? String(decoded.sessionId) : null,
            };
        } catch {
            return null;
        }
    }

    identifyAccess(token: string): string | null {
        try {
            const decoded = jwt.verify(token, this.accessPublicKey(), {
                algorithms: ['RS256'],
                ignoreExpiration: true,
            }) as {
                id?: string;
                user_id?: string;
                tokenType?: string;
                typ?: string;
            };
            if (decoded.tokenType === 'refresh' || decoded.typ === 'refresh') {
                return null;
            }
            const id = decoded.id || decoded.user_id;
            return id ? String(id) : null;
        } catch {
            return null;
        }
    }
}
