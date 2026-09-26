import {
    Injectable,
    NotFoundException,
    OnModuleInit,
    UnauthorizedException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Request } from 'express';
import type { Actor } from '../../authz/policy';
import { ConfigService } from '@nestjs/config';
import { parseDevice } from '../../common/device';
import { clientIp, formatLocation, lookupVisitorGeo } from '../../common/geo';
import { MailService } from '../../common/mail.service';
import { Session } from '../../database/schemas/session.schema';
import { REFRESH_TTL_MS } from '../../database/schemas/session.schema';
import { getRefreshCookies } from './auth.cookies';
import { loginAlertTemplate } from './login-alert';
import { hashToken } from './password';
import { TokenService } from './token.service';
import { UsersService } from '../users/users.service';

@Injectable()
export class SessionService implements OnModuleInit {
    constructor(
        @InjectModel(Session.name) private readonly sessions: Model<Session>,
        private readonly tokens: TokenService,
        private readonly users: UsersService,
        private readonly mail: MailService,
        private readonly config: ConfigService,
    ) {}

    async onModuleInit() {
        await this.dropUniqueUserIndex();
    }

    private async dropUniqueUserIndex() {
        try {
            const indexes = await this.sessions.collection.indexes();
            for (const index of indexes) {
                const keys = Object.keys(index.key || {});
                if (
                    index.unique &&
                    keys.length === 1 &&
                    keys[0] === 'user' &&
                    index.name
                ) {
                    await this.sessions.collection.dropIndex(index.name);
                }
            }
        } catch {
            // index may not exist yet
        }
    }

    private userClauses(userId: string) {
        const clauses: Array<{ user: string | Types.ObjectId }> = [
            { user: userId },
        ];
        if (Types.ObjectId.isValid(userId)) {
            clauses.push({ user: new Types.ObjectId(userId) });
        }
        return clauses;
    }

    private userFilter(userId: string) {
        return { $or: this.userClauses(userId) };
    }

    private notifyLogin(
        user: { email?: string | null; nick_name?: string | null },
        session: { device: string; location: string; ip: string },
    ) {
        if (!user?.email) return;
        const origin = this.config.get<string>('FRONTEND_ORIGIN');
        const settingsUrl = origin
            ? `${String(origin).replace(/\/$/, '')}/settings?tab=sessions`
            : '';
        const time = new Date().toLocaleString('ru-RU', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            timeZone: 'Europe/Kyiv',
        });
        void this.mail
            .sendEmail({
                to: user.email,
                subject: 'Новый вход в аккаунт Scribo',
                html: loginAlertTemplate({
                    nickName: user.nick_name,
                    device: session.device,
                    location: session.location,
                    ip: session.ip,
                    time,
                    settingsUrl,
                }),
            })
            .catch((error) => {
                console.error('Failed to send login alert email', error);
            });
    }

    async issueSession(
        user: {
            _id: Types.ObjectId;
            email: string;
            role: Actor['role'];
            nick_name: string;
        },
        req: Request,
    ) {
        const geo = await lookupVisitorGeo(req);
        const ip = geo.ip || clientIp(req);
        const device = parseDevice(String(req.headers['user-agent'] || ''));
        const location = formatLocation(geo, 'Unknown');
        const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
        const sessionId = new Types.ObjectId();
        const refreshToken = this.tokens.encodeRefresh(user._id, sessionId);
        const doc = {
            _id: sessionId,
            user: new Types.ObjectId(String(user._id)),
            refreshTokenHash: hashToken(refreshToken),
            device,
            location,
            ip,
            lastSeen: new Date(),
            expiresAt,
        };

        await this.dropUniqueUserIndex();
        try {
            await this.sessions.create(doc);
        } catch (error) {
            const code = (error as { code?: number }).code;
            if (code !== 11000) {
                throw error;
            }
            await this.dropUniqueUserIndex();
            await this.sessions.create(doc);
        }

        this.notifyLogin(user, { device, location, ip });

        return {
            accessToken: this.tokens.encodeAccess(user, String(sessionId)),
            refreshToken,
        };
    }

    private refreshPayloads(req: Request) {
        return getRefreshCookies(req.headers.cookie).map((token) => ({
            token,
            payload: this.tokens.decodeRefresh(token),
        }));
    }

    async logoutSession(req: Request, actor?: Actor) {
        const sessionIds = new Set<string>();
        for (const { payload } of this.refreshPayloads(req)) {
            if (payload?.sessionId) sessionIds.add(String(payload.sessionId));
        }
        const header = req.headers.authorization;
        const access =
            actor ||
            (header?.startsWith('Bearer ')
                ? this.tokens.peekAccess(header.slice(7))
                : null);
        if (access?.sessionId) sessionIds.add(String(access.sessionId));
        for (const sessionId of sessionIds) {
            await this.sessions.findByIdAndDelete(sessionId);
        }
    }

    async refreshSession(req: Request) {
        await this.sessions.deleteMany({ expiresAt: { $lte: new Date() } });
        const tokens = getRefreshCookies(req.headers.cookie);
        if (!tokens.length) {
            throw new UnauthorizedException('Refresh token is missing');
        }

        let lastError = 'Refresh token is invalid';
        for (const token of tokens) {
            const payload = this.tokens.decodeRefresh(token);
            if (!payload) continue;
            const session = await this.sessions
                .findById(payload.sessionId)
                .lean();
            if (!session || String(session.user) !== String(payload.id)) {
                lastError = 'Session is not found';
                continue;
            }
            if (session.expiresAt <= new Date()) {
                await this.sessions.findByIdAndDelete(session._id);
                lastError = 'Session has expired';
                continue;
            }
            if (session.refreshTokenHash !== hashToken(token)) {
                lastError = 'Refresh token is invalid';
                continue;
            }
            const user = await this.users.getById(String(session.user));
            if (!user) {
                await this.sessions.findByIdAndDelete(session._id);
                lastError = 'User is not found';
                continue;
            }
            const geo = await lookupVisitorGeo(req);
            const patch: Record<string, unknown> = { lastSeen: new Date() };
            if (geo.city || geo.country) {
                patch.location = formatLocation(geo, session.location);
                patch.ip = geo.ip || session.ip;
            }
            await this.sessions.findByIdAndUpdate(session._id, patch);

            return {
                accessToken: this.tokens.encodeAccess(
                    user as never,
                    String(session._id),
                ),
                refreshToken: token,
            };
        }

        throw new UnauthorizedException(lastError);
    }

    async listUserSessions(actor: Actor, req: Request) {
        const now = new Date();
        const userFilter = this.userFilter(actor.id);
        await this.sessions.collection.deleteMany({
            ...userFilter,
            expiresAt: { $lte: now },
        });
        const sessions = await this.sessions.collection
            .find({
                ...userFilter,
                expiresAt: { $gt: now },
            })
            .project({ refreshTokenHash: 0 })
            .sort({ lastSeen: -1 })
            .toArray();
        const cookieSessionId = this.refreshPayloads(req).find(
            (item) => item.payload,
        )?.payload?.sessionId;
        const currentId = actor.sessionId
            ? String(actor.sessionId)
            : cookieSessionId
              ? String(cookieSessionId)
              : null;
        return sessions.map((session) => ({
            _id: String(session._id),
            user: String(session.user),
            device: session.device,
            location: session.location,
            ip: session.ip,
            lastSeen: session.lastSeen,
            expiresAt: session.expiresAt,
            isCurrent: currentId === String(session._id),
        }));
    }

    async revokeSession(actor: Actor, sessionId: string, req: Request) {
        const session = await this.sessions.findById(sessionId).lean();
        if (!session || String(session.user) !== actor.id) {
            throw new NotFoundException('Session is not found');
        }
        await this.sessions.findByIdAndDelete(sessionId);
        const current = this.refreshPayloads(req).find(
            (item) => item.payload,
        )?.payload;
        return {
            wasCurrent: Boolean(
                current?.sessionId &&
                String(current.sessionId) === String(sessionId),
            ),
        };
    }
}
