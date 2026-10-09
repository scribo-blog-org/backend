import { currentRequest } from '../../infra/request-context';
import {
    Injectable,
    NotFoundException,
    UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { fieldError } from '../../http/http-errors';
import { LoggerService } from '../../infra/logger.service';
import { UsersService } from '../users/users.service';
import { comparePassword } from './password';
import { SessionService } from './session.service';

@Injectable()
export class AuthService {
    constructor(
        private readonly users: UsersService,
        private readonly sessions: SessionService,
        private readonly logger: LoggerService,
    ) {}

    private async logLogin(
        user: { _id: unknown; nick_name?: string; role?: string },
        method: 'password' | 'google',
    ) {
        await this.logger.log({
            type: 'login',
            message: `User ${user.nick_name ?? user._id} logged in`,
            data: {
                user: user._id,
                user_nick: user.nick_name ?? null,
                user_role: user.role ?? null,
                method,
            },
        });
    }

    private loginFailed(
        reason: string,
        method: 'password' | 'google',
        identifier?: string,
    ) {
        const who = identifier?.toLowerCase() ?? 'unknown';
        return this.logger.diagnostic({
            type: 'login_failed',
            message: `Failed sign-in${identifier ? ` for ${identifier}` : ''}`,
            key: `login_failed|${currentRequest()?.ip ?? ''}|${who}|${reason}`,
            data: {
                method,
                reason,
                ...(identifier ? { email: identifier } : {}),
            },
        });
    }

    async emailFromGoogleToken(googleToken: string) {
        const response = await fetch(
            'https://www.googleapis.com/oauth2/v3/userinfo',
            {
                headers: { Authorization: `Bearer ${googleToken}` },
            },
        ).catch((error: unknown) => {
            void this.logger.externalFailed('google', error);
            throw error;
        });

        if (response.status === 401) {
            return null;
        }
        if (!response.ok) {
            void this.logger.externalFailed(
                'google',
                new Error(`userinfo answered ${response.status}`),
            );
            return null;
        }

        const data = (await response.json()) as { email?: string };
        return data.email || null;
    }

    private invalidGoogleToken(googleToken: string) {
        return fieldError(
            'googleToken',
            'Google token is invalid',
            googleToken,
        );
    }

    async verifyGoogleToken(googleToken: string) {
        const email = await this.emailFromGoogleToken(googleToken);
        if (!email) {
            throw this.invalidGoogleToken(googleToken);
        }

        const user = await this.users.getByQuery({ email });
        return {
            email,
            is_registered: Boolean(user),
        };
    }

    async loginByUsername(userName: string, password: string, req: Request) {
        const user = await this.users.getByQuery(
            {
                $or: [
                    { email: userName.toLowerCase() },
                    { nick_name: userName },
                ],
            },
            { withPassword: true },
        );

        if (!user) {
            await this.loginFailed('no_user', 'password', userName);
            throw new NotFoundException(
                'User with this email or nick name is not found',
            );
        }

        if (
            !user.password ||
            !(await comparePassword(password, user.password))
        ) {
            await this.loginFailed('bad_password', 'password', userName);
            throw new UnauthorizedException('Invalid password or login');
        }

        const { password: _password, ...safeUser } = user;
        const tokens = await this.sessions.issueSession(safeUser as never, req);
        await this.logLogin(user, 'password');
        return tokens;
    }

    async loginByGoogle(googleToken: string, req: Request) {
        const email = await this.emailFromGoogleToken(googleToken);
        if (!email) {
            await this.loginFailed('google_invalid', 'google');
            throw this.invalidGoogleToken(googleToken);
        }
        const user = await this.users.getByQuery({ email });
        if (!user) {
            await this.loginFailed('no_user', 'google', email);
            throw new NotFoundException('User with this email is not found');
        }
        const tokens = await this.sessions.issueSession(user as never, req);
        await this.logLogin(user, 'google');
        return tokens;
    }
}
