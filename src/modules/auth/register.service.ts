import {
    HttpStatus,
    Injectable,
    InternalServerErrorException,
    UnauthorizedException,
} from '@nestjs/common';
import { MailService } from '../../infra/mail.service';
import { StorageService } from '../../infra/storage.service';
import { LoggerService } from '../../infra/logger.service';
import { fieldError } from '../../http/http-errors';
import { UsersService } from '../users/users.service';
import { EmailCodesService } from './email-codes.service';
import { setPasswordHash } from './password';
import { AuthService } from './auth.service';

@Injectable()
export class RegisterService {
    constructor(
        private readonly users: UsersService,
        private readonly codes: EmailCodesService,
        private readonly mail: MailService,
        private readonly storage: StorageService,
        private readonly auth: AuthService,
        private readonly logger: LoggerService,
    ) {}

    async requestVerificationCode(userEmail: string) {
        const normalized = userEmail.toLowerCase();
        const user = await this.users.getByQuery({ email: normalized });
        if (user) {
            throw fieldError(
                'userEmail',
                'User with this email is already exists!',
                userEmail,
                HttpStatus.CONFLICT,
            );
        }

        const code = Math.floor(100000 + Math.random() * 900000).toString();
        await this.mail.sendEmail({
            to: userEmail,
            subject: 'Your verification code',
            code,
        });
        const result = await this.codes.createRegisterCode(userEmail, code);
        if (!result) {
            throw new InternalServerErrorException(
                'Failed to create verification code!',
            );
        }
        return result;
    }

    async confirmEmailCode(userEmail: string, emailCode: string) {
        const record = await this.codes.get(userEmail);
        if (!record) {
            throw fieldError(
                'userEmail',
                'No pending confirmation found for this email address. Please request a new code!',
                userEmail,
            );
        }
        if (record.code !== emailCode) {
            throw fieldError(
                'emailCode',
                'Invalid verification code!',
                emailCode,
            );
        }
        return true;
    }

    private async register(input: {
        userNickName: string;
        userDescription?: string;
        userPassword: string;
        avatar?: Express.Multer.File;
        userEmail: string;
    }) {
        if (await this.users.getByQuery({ email: input.userEmail })) {
            throw fieldError(
                'userEmail',
                'User with this email is exists',
                input.userEmail,
                HttpStatus.CONFLICT,
            );
        }
        if (await this.users.getByQuery({ nick_name: input.userNickName })) {
            throw fieldError(
                'userNickName',
                'This nick name is already taken',
                input.userNickName,
                HttpStatus.CONFLICT,
            );
        }

        const user = await this.users.create({
            nick_name: input.userNickName,
            password: setPasswordHash(input.userPassword),
            description: input.userDescription,
            email: input.userEmail,
        });
        if (!user) {
            throw new InternalServerErrorException('Failed to create user');
        }

        let avatarUrl: string | null = null;
        if (input.avatar && user) {
            avatarUrl = await this.storage.uploadImage(
                input.avatar,
                'avatar',
                String(user._id),
                'userAvatar',
            );
            if (!avatarUrl) {
                throw new InternalServerErrorException(
                    'Error to upload avatar image',
                );
            }
            await this.users.updateById(String(user._id), {
                avatar: avatarUrl,
            });
        }

        await this.logger.log({
            type: 'register',
            message: `User ${user.nick_name} has registered`,
            data: { user: user._id },
        });

        return { ...user, avatar: avatarUrl };
    }

    async registerByEmail(input: {
        userNickName: string;
        userDescription?: string;
        userPassword: string;
        avatar?: Express.Multer.File;
        userEmail: string;
        emailCode: string;
    }) {
        const ok = await this.confirmEmailCode(
            input.userEmail,
            input.emailCode,
        );
        if (!ok) {
            throw new UnauthorizedException('Invalid email or code');
        }
        const user = await this.register(input);
        await this.codes.delete(input.userEmail);
        return user;
    }

    async registerByGoogle(input: {
        userNickName: string;
        userDescription?: string;
        userPassword: string;
        avatar?: Express.Multer.File;
        googleToken: string;
    }) {
        const email = await this.auth.emailFromGoogleToken(input.googleToken);
        if (!email) {
            throw fieldError(
                'googleToken',
                'Google token is invalid',
                input.googleToken,
            );
        }
        return this.register({ ...input, userEmail: email });
    }
}
