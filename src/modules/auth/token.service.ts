import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import type { Role } from '../../authz/roles';

const ACCESS_TTL = '15m';
const REFRESH_TTL = '30d';

function parseJwk(raw: string): crypto.JsonWebKey {
    const trimmed = raw.trim();
    try {
        return JSON.parse(trimmed) as crypto.JsonWebKey;
    } catch (error) {
        const unescaped = trimmed.replace(/\\"/g, '"');
        if (unescaped === trimmed) {
            throw error;
        }
        return JSON.parse(unescaped) as crypto.JsonWebKey;
    }
}

export type AccessUser = {
    _id: unknown;
    email: string;
    role: Role;
    nick_name: string;
};

@Injectable()
export class TokenService {
    constructor(private readonly config: ConfigService) {}

    private accessKey() {
        return this.config.getOrThrow<string>('JWTKEY');
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
        return jwt.sign(payload, this.accessKey(), { expiresIn: ACCESS_TTL });
    }

    private formatPemKey(key: string, type: 'PUBLIC' | 'PRIVATE') {
        const cleaned = key
            .replace(/\\n/g, '\n')
            .replace(new RegExp(`-----BEGIN ${type} KEY-----`, 'g'), '')
            .replace(new RegExp(`-----END ${type} KEY-----`, 'g'), '')
            .replace(/[^A-Za-z0-9+/=]/g, '');

        const chunked = cleaned.match(/.{1,64}/g)?.join('\n') || '';

        return `-----BEGIN ${type} KEY-----\n${chunked}\n-----END ${type} KEY-----`;
    }

    encodeSocket(user: any) {
        const userId = String(user._id || user.id);
        const now = Math.floor(Date.now() / 1000);
        const expiresIn = 3600;

        const payload = {
            sub: userId,
            id: userId,
            role: 'authenticated',
            aud: 'authenticated',
            iat: now,
            exp: now + expiresIn,
        };

        const rawKey = this.config.getOrThrow<string>('SOCKET_JWT_SECRET_KEY');
        const kid = this.config.get<string>('SOCKET_JWT_KID');

        const privateKey = crypto.createPrivateKey({
            key: parseJwk(rawKey),
            format: 'jwk',
        });

        const signOptions: jwt.SignOptions = {
            algorithm: 'RS256',
        };

        if (kid) {
            signOptions.keyid = kid;
        }

        return jwt.sign(payload, privateKey, signOptions);
    }

    verifySocket(token: string) {
        const rawKey = this.config.getOrThrow<string>('SOCKET_JWT_PUBLIC_KEY');

        const publicKeyObject = crypto.createPublicKey({
            key: parseJwk(rawKey),
            format: 'jwk',
        });

        return jwt.verify(token, publicKeyObject, { algorithms: ['RS256'] });
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
            const decoded = jwt.verify(token, this.accessKey(), {
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
