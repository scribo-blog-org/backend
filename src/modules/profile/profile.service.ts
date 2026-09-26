import {
    HttpStatus,
    Injectable,
    InternalServerErrorException,
    UnauthorizedException,
} from '@nestjs/common';
import { ROLE_MANAGEMENT } from '../../authz/role-management';
import { ROLE_PERMISSIONS } from '../../authz/role-permissions';
import type { Actor } from '../../authz/policy';
import { StorageService } from '../../infra/storage.service';
import { fieldError } from '../../http/http-errors';
import { comparePassword, setPasswordHash } from '../auth/password';
import { UsersService } from '../users/users.service';
import { MailService } from '../../infra/mail.service';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ProfileService {
    constructor(
        private readonly users: UsersService,
        private readonly storage: StorageService,
        private readonly mail: MailService,
        private readonly config: ConfigService,
    ) {}

    withAccessRole(user: Record<string, unknown> | null, actor?: Actor) {
        if (!user) return user;
        const role = actor?.role || (user.role as Actor['role']);
        const data = {
            ...user,
            role,
            permissions: ROLE_PERMISSIONS[role] ?? [],
        } as Record<string, unknown>;
        if (ROLE_MANAGEMENT[role]) {
            data.role_management = ROLE_MANAGEMENT[role];
        } else {
            delete data.role_management;
        }
        return data;
    }

    async get(actor: Actor) {
        const user = await this.users.getById(actor.id, {
            withNotifications: true,
            withSavedPosts: true,
            viewerId: actor.id,
        });
        if (!user) {
            throw new UnauthorizedException('Unauthorized');
        }
        return this.withAccessRole(user as never, actor);
    }

    async edit(
        actor: Actor,
        fields: Record<string, unknown>,
        avatar?: Express.Multer.File,
    ) {
        const stored = await this.users.getById(actor.id);
        if (!stored) {
            throw new UnauthorizedException('Unauthorized');
        }

        if (typeof fields.userNickName === 'string') {
            const owner = await this.users.getByQuery({
                nick_name: fields.userNickName,
            });
            if (owner && String(owner._id) !== actor.id) {
                throw fieldError(
                    'userNickName',
                    'Nick name is already used by another user!',
                    fields.userNickName,
                    HttpStatus.CONFLICT,
                );
            }
        }

        const mongoFields: Record<string, unknown> = {};
        if (fields.userNickName !== undefined)
            mongoFields.nick_name = fields.userNickName;
        if (fields.userDescription !== undefined)
            mongoFields.description = fields.userDescription;
        if (fields.isEmailPublic !== undefined)
            mongoFields.is_email_public = fields.isEmailPublic;
        if (fields.isSavedPostsPublic !== undefined)
            mongoFields.is_saved_posts_public = fields.isSavedPostsPublic;
        if (fields.isLastActivityPublic !== undefined)
            mongoFields.is_last_activity_public = fields.isLastActivityPublic;

        if (avatar || fields.userAvatar === null || fields.userAvatar === '') {
            if (stored && 'avatar' in stored && stored.avatar) {
                await this.storage.deleteFile(
                    String((stored as { avatar?: string }).avatar),
                );
            }
            if (avatar) {
                const url = await this.storage.uploadImage(
                    avatar,
                    'avatar',
                    actor.id,
                    'userAvatar',
                );
                if (!url) {
                    throw new InternalServerErrorException(
                        'Error to upload image to storage!',
                    );
                }
                mongoFields.avatar = url;
            } else {
                mongoFields.avatar = null;
            }
        }

        const result = await this.users.updateById(actor.id, mongoFields);
        return this.withAccessRole(result as never, actor);
    }

    async readNotifications(actor: Actor) {
        const user = await this.users.getById(actor.id, {
            withNotifications: true,
        });
        if (!user) {
            throw new UnauthorizedException('Unauthorized');
        }
        const result = await this.users.markNotificationsRead(actor.id);
        return {
            notifications: (result as { notifications?: unknown } | null)
                ?.notifications,
        };
    }

    async changePassword(
        actor: Actor,
        input: {
            currentPassword: string;
            newPassword: string;
            newPasswordConfirm: string;
        },
    ) {
        if (input.newPassword !== input.newPasswordConfirm) {
            throw fieldError('newPasswordConfirm', 'Пароли не совпадают');
        }
        if (input.currentPassword === input.newPassword) {
            throw fieldError(
                'newPassword',
                'Новый пароль должен отличаться от текущего',
            );
        }
        const user = await this.users.getById(actor.id, { withPassword: true });
        if (!user) {
            throw new UnauthorizedException('Unauthorized');
        }
        if (!user.password) {
            throw fieldError(
                'currentPassword',
                'Для этого аккаунта нельзя сменить пароль',
            );
        }
        if (!(await comparePassword(input.currentPassword, user.password))) {
            throw fieldError('currentPassword', 'Неверный текущий пароль');
        }
        await this.users.updateById(actor.id, {
            password: setPasswordHash(input.newPassword),
        });
    }
}
