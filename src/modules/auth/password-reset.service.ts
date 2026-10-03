import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MailService } from '../../infra/mail.service';
import { fieldError } from '../../http/http-errors';
import { UsersService } from '../users/users.service';
import { EmailCodesService, RESET_PURPOSE } from './email-codes.service';
import { setPasswordHash } from './password';

const MAX_CODE_ATTEMPTS = 5;

function invalidCodeError() {
    return fieldError('emailCode', 'Invalid code');
}

@Injectable()
export class PasswordResetService {
    constructor(
        private readonly users: UsersService,
        private readonly codes: EmailCodesService,
        private readonly mail: MailService,
        private readonly config: ConfigService,
    ) {}

    private normalize(email: string) {
        return String(email || '')
            .trim()
            .toLowerCase();
    }

    async request(email: string) {
        const normalized = this.normalize(email);
        const user = await this.users.findByEmailInsensitive(normalized, {
            withPassword: true,
        });
        if (!user?.email) {
            return;
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        await this.codes.upsertPasswordResetCode(normalized, code);
        try {
            await this.mail.sendEmail({
                to: user.email,
                subject: 'Scribo password reset code',
                html: `<p>Code: <b>${code}</b></p>`,
            });
        } catch (error) {
            console.error('Failed to send password reset email', error);
        }
    }

    private async assertResetCode(email: string, emailCode: string) {
        const normalized = this.normalize(email);
        const record = await this.codes.get(normalized, RESET_PURPOSE);
        if (
            !record ||
            (record.attempts || 0) >= MAX_CODE_ATTEMPTS ||
            !this.codes.codesMatch(record.code, emailCode)
        ) {
            if (record) {
                const updated = await this.codes.incrementAttempts(
                    normalized,
                    RESET_PURPOSE,
                );
                if ((updated?.attempts || 0) >= MAX_CODE_ATTEMPTS) {
                    await this.codes.delete(normalized, RESET_PURPOSE);
                }
            }
            throw invalidCodeError();
        }
        return normalized;
    }

    async confirm(email: string, emailCode: string) {
        await this.assertResetCode(email, emailCode);
    }

    async reset(input: {
        userEmail: string;
        emailCode: string;
        newPassword: string;
        newPasswordConfirm: string;
    }) {
        if (input.newPassword !== input.newPasswordConfirm) {
            throw fieldError('newPasswordConfirm', 'Passwords do not match');
        }
        const normalized = await this.assertResetCode(
            input.userEmail,
            input.emailCode,
        );
        const user = await this.users.findByEmailInsensitive(normalized, {
            withPassword: true,
        });
        if (!user) {
            throw invalidCodeError();
        }
        await this.users.updateById(String(user._id), {
            password: setPasswordHash(input.newPassword),
        });
        await this.users.deleteSessions(String(user._id));
        await this.codes.delete(normalized, RESET_PURPOSE);
        if (user.email) {
            const settingsUrl = this.config.get<string>('FRONTEND_ORIGIN')
                ? `${String(this.config.get('FRONTEND_ORIGIN')).replace(/\/$/, '')}/settings?tab=sessions`
                : '';
            try {
                await this.mail.sendEmail({
                    to: user.email,
                    subject: 'Your Scribo password was changed',
                    html: `<p>Password changed.${settingsUrl ? ` <a href="${settingsUrl}">Sessions</a>` : ''}</p>`,
                });
            } catch (error) {
                console.error('Failed to send password change email', error);
            }
        }
    }
}
