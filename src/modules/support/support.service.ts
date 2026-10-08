import {
    ForbiddenException,
    HttpStatus,
    Injectable,
    NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { randomBytes } from 'crypto';
import { Model, Types } from 'mongoose';
import { PERMISSIONS } from '../../authz/permissions';
import { hasPermission, type Actor } from '../../authz/policy';
import { NotificationsService } from '../notifications/notifications.service';
import { fieldError } from '../../http/http-errors';
import { FIELD_LIMITS } from '../../validation/field-limits';
import { LoggerService } from '../../infra/logger.service';
import { textPreview } from '../../infra/log-helpers';
import { MailService } from '../../infra/mail.service';
import { SocketService } from '../../socket/socket.service';
import { paginationMeta, parsePagination } from '../../http/pagination';
import type { ListSupportQueryDto } from '../../http/query.dto';
import { supportEmailTemplate } from './support-email';
import { SupportRequest } from '../../database/schemas/support-request.schema';
import { UsersService } from '../users/users.service';
import { CreateNotification } from '../notifications/notifications.type';

const KIND_LABELS: Record<string, string> = {
    complaint: 'Complaint',
    request: 'Request',
    help: 'Help',
};

const STATUS_LABELS: Record<string, string> = {
    new: 'New',
    in_review: 'In review',
    reviewed: 'Reviewed',
};

const SORT_FIELDS: Record<string, string> = {
    created_date: 'created_date',
    updated_date: 'updated_date',
};

type SupportLean = {
    _id: Types.ObjectId;
    email: string;
    kind: string;
    message: string;
    status: string;
    access_key?: string;
    anonymous?: boolean;
    user?: Types.ObjectId | null;
    created_date: Date;
    updated_date: Date;
    replies?: {
        _id?: Types.ObjectId;
        text: string;
        created_date: Date;
        author_type?: string;
        admin?: Types.ObjectId | null;
    }[];
};

@Injectable()
export class SupportService {
    constructor(
        @InjectModel(SupportRequest.name)
        private readonly tickets: Model<SupportRequest>,
        private readonly users: UsersService,
        private readonly notifications: NotificationsService,
        private readonly mail: MailService,
        private readonly socket: SocketService,
        private readonly logger: LoggerService,
        private readonly config: ConfigService,
    ) {}

    private normalizeStatus(status?: string) {
        if (status === 'open') return 'new';
        if (status === 'answered') return 'reviewed';
        return status || '';
    }

    private statusFilter(status?: string) {
        const normalized = this.normalizeStatus(status);
        if (normalized === 'new') return { status: { $in: ['new', 'open'] } };
        if (normalized === 'reviewed')
            return { status: { $in: ['reviewed', 'answered'] } };
        if (normalized === 'in_review') return { status: 'in_review' };
        return {};
    }

    // Staff see a dot while at least one request is new. Sending the current
    // total instead of a delta keeps every open admin tab correct, whoever
    // changed the request.
    private async broadcastNewCount() {
        try {
            const count = await this.tickets.countDocuments(
                this.statusFilter('new'),
            );
            this.socket.adminSupportNew(count);
        } catch (error) {
            console.error('Failed to broadcast new support requests', error);
        }
    }

    private requestPageUrl(accessKey?: string) {
        const origin = this.config.get<string>('FRONTEND_ORIGIN') || '';
        if (!origin || !accessKey) return null;
        return `${origin.replace(/\/$/, '')}/support/${accessKey}`;
    }

    private previewMessage(message: string) {
        const text = String(message || '').trim();
        if (text.length <= 140) return text;
        return `${text.slice(0, 140).trim()}…`;
    }

    private isAnonymousTicket(item: SupportLean) {
        if (item.anonymous === false) return false;
        if (item.anonymous === true) return true;
        return !item.user;
    }

    private isClosedTicket(item: SupportLean) {
        return this.normalizeStatus(item.status) === 'reviewed';
    }

    private isTicketOwner(item: SupportLean, actor?: Actor) {
        if (!item.user || !actor?.id) return false;
        return String(item.user) === String(actor.id);
    }

    private canManage(actor?: Actor) {
        return hasPermission(actor, PERMISSIONS.MANAGE_SUPPORT);
    }

    private toListItem(item: SupportLean) {
        return {
            _id: item._id,
            access_key: item.access_key,
            email: item.email,
            kind: item.kind,
            status: this.normalizeStatus(item.status),
            message_preview: this.previewMessage(item.message),
            replies_count: item.replies?.length || 0,
            created_date: item.created_date,
            updated_date: item.updated_date,
        };
    }

    private async toDetail(item: SupportLean) {
        const adminIds = [
            ...new Set(
                (item.replies || [])
                    .map((reply) => reply.admin)
                    .filter(Boolean),
            ),
        ];
        const [requester] = item.user
            ? await this.users.getPublicByIds([item.user])
            : [];
        const admins = await this.users.getPublicByIds(adminIds);
        const adminsById = new Map(
            admins.map((admin) => [String(admin._id), admin]),
        );

        const replies = (item.replies || []).map((reply) => {
            const admin = adminsById.get(String(reply.admin)) || null;
            const author_type =
                reply.author_type || (reply.admin ? 'staff' : 'requester');
            return {
                _id: reply._id,
                text: reply.text,
                created_date: reply.created_date,
                author_type,
                admin:
                    author_type === 'staff' && admin
                        ? {
                              _id: admin._id,
                              nick_name: admin.nick_name,
                              avatar: admin.avatar,
                          }
                        : null,
            };
        });

        return {
            _id: item._id,
            access_key: item.access_key,
            email: item.email,
            kind: item.kind,
            message: item.message,
            created_date: item.created_date,
            updated_date: item.updated_date,
            anonymous: this.isAnonymousTicket(item),
            requester: requester
                ? {
                      _id: requester._id,
                      nick_name: requester.nick_name,
                      avatar: requester.avatar,
                      is_verified: requester.is_verified,
                  }
                : null,
            closed: this.isClosedTicket(item),
            can_reply: false,
            is_owner: false,
            replies,
            status: this.normalizeStatus(item.status),
        };
    }

    private withAccessFlags(
        detail: Awaited<ReturnType<SupportService['toDetail']>>,
        item: SupportLean,
        actor?: Actor,
    ) {
        const staff = this.canManage(actor);
        const owner = this.isTicketOwner(item, actor);
        const closed = this.isClosedTicket(item);
        const anonymous = this.isAnonymousTicket(item);
        return {
            ...detail,
            anonymous,
            closed,
            is_owner: owner,
            can_reply: !closed && (staff || (owner && !anonymous)),
            ...(staff || owner
                ? { status: this.normalizeStatus(item.status) }
                : { status: undefined }),
            requester: staff || owner ? detail.requester : null,
            email: staff ? item.email : undefined,
        };
    }

    private async notifyTicketOwner(
        item: SupportLean,
        notification: CreateNotification,
        emailPayload: {
            title: string;
            intro: string;
            message?: string;
        },
    ) {
        // The email always goes out, also for account owners: the in-app
        // notification and the request list stay as they are.
        this.notifyByEmail(item, emailPayload);
        if (item.user) {
            await this.notifications.sendNotification(
                String(item.user),
                notification,
            );
        }
    }

    private notifyByEmail(
        item: SupportLean,
        payload: { title: string; intro: string; message?: string },
    ) {
        if (!item.email) return;
        void this.sendSupportMail({
            ...payload,
            to: item.email,
            url: this.requestPageUrl(item.access_key),
        });
    }

    private async sendSupportMail(input: {
        to: string;
        title: string;
        intro: string;
        message?: string;
        url?: string | null;
    }) {
        try {
            await this.mail.sendEmail({
                to: input.to,
                subject: input.title,
                html: supportEmailTemplate(input),
            });
        } catch (error) {
            console.error('Failed to send support email', error);
        }
    }

    private assertReplyText(text: string) {
        const message = String(text || '').trim();
        if (!message) {
            throw fieldError(
                'replyText',
                'Reply text must be not empty!',
                text,
            );
        }
        if (message.length > FIELD_LIMITS.supportReply.max) {
            throw fieldError(
                'replyText',
                `Reply cannot be longer than ${FIELD_LIMITS.supportReply.max} characters!`,
                text,
            );
        }
        return message;
    }

    private assertCanReply(item: SupportLean, actor?: Actor) {
        if (this.isClosedTicket(item)) {
            throw new ForbiddenException('This request is closed');
        }
        if (this.canManage(actor)) return 'staff';
        if (this.isAnonymousTicket(item) || !this.isTicketOwner(item, actor)) {
            throw new ForbiddenException(
                "You don't have permission to reply to this request",
            );
        }
        return 'requester';
    }

    async create(
        body: {
            userEmail?: string;
            supportKind: string;
            supportMessage: string;
        },
        actor?: Actor,
    ) {
        const supportKind = body.supportKind;
        const supportMessage = String(body.supportMessage || '').trim();
        const access_key = randomBytes(32).toString('hex');
        const userId = actor?.id || null;
        const authenticated = Boolean(userId);

        let email = String(body.userEmail || '')
            .trim()
            .toLowerCase();

        if (authenticated && userId) {
            const user = await this.users.getById(userId);
            if (!user?.email) {
                throw fieldError(
                    'userEmail',
                    'Account email is required to create a request',
                    '',
                );
            }
            email = String(user.email).trim().toLowerCase();
        } else if (!email) {
            throw fieldError('userEmail', 'Missing email!', '');
        }

        const created = await this.tickets.create({
            email,
            kind: supportKind,
            message: supportMessage,
            status: 'new',
            access_key,
            anonymous: !authenticated,
            user: authenticated ? userId : null,
            created_date: new Date(),
            updated_date: new Date(),
            replies: [],
        });

        await this.broadcastNewCount();

        const kindLabel = KIND_LABELS[supportKind] || supportKind;
        void this.sendSupportMail({
            to: email,
            title: 'We received your request',
            intro: `Thanks. We received your request (${kindLabel}). You can read the team's replies on the request page.`,
            message: supportMessage,
            url: this.requestPageUrl(access_key),
        });

        await this.logger.log({
            type: 'create_support_request',
            message: authenticated
                ? `User created support request ${created._id}`
                : `Guest created support request ${created._id}`,
            data: {
                support_request: created._id,
                access_key,
                kind: supportKind,
                user: userId,
                anonymous: !authenticated,
                message_preview: textPreview(supportMessage),
                ...(authenticated ? {} : { email }),
            },
        });

        return { _id: created._id, access_key };
    }

    async list(query: ListSupportQueryDto, actor: Actor) {
        if (!this.canManage(actor)) {
            throw new ForbiddenException(
                "You don't have permission to view support requests",
            );
        }
        const { page, limit, skip } = parsePagination(query, 9, 50);
        const filter: Record<string, unknown> = {};
        if (query.status)
            Object.assign(filter, this.statusFilter(query.status));
        if (query.kind) filter.kind = query.kind;
        const sortField = SORT_FIELDS[query.sort || ''] || 'created_date';
        const sortOrder = query.order === 'asc' ? 1 : -1;
        const total = await this.tickets.countDocuments(filter);
        const items = await this.tickets
            .find(filter)
            .sort({ [sortField]: sortOrder })
            .skip(skip)
            .limit(limit)
            .lean<SupportLean[]>();
        return {
            items: items.map((item) => this.toListItem(item)),
            pagination: paginationMeta(page, limit, total),
        };
    }

    async listMine(query: ListSupportQueryDto, actor: Actor) {
        if (!actor?.id) {
            throw new ForbiddenException(
                'You must be logged in to view your requests',
            );
        }
        const { page, limit, skip } = parsePagination(query, 9, 50);
        const filter = { user: actor.id };
        const total = await this.tickets.countDocuments(filter);
        const items = await this.tickets
            .find(filter)
            .sort({ created_date: -1 })
            .skip(skip)
            .limit(limit)
            .lean<SupportLean[]>();
        return {
            items: items.map((item) => {
                const row = this.toListItem(item);
                delete (row as { email?: string }).email;
                return row;
            }),
            pagination: paginationMeta(page, limit, total),
        };
    }

    async getById(id: string, actor: Actor) {
        if (!this.canManage(actor)) {
            throw new ForbiddenException(
                "You don't have permission to view support requests",
            );
        }
        let item = await this.tickets.findById(id).lean<SupportLean>();
        if (!item) throw new NotFoundException('Support request not found');
        if (!item.access_key) {
            item = (await this.tickets
                .findByIdAndUpdate(
                    id,
                    { $set: { access_key: randomBytes(32).toString('hex') } },
                    { returnDocument: 'after' },
                )
                .lean<SupportLean>())!;
        }
        return this.withAccessFlags(await this.toDetail(item), item, actor);
    }

    async getPublic(accessKey: string, actor?: Actor) {
        const item = await this.tickets
            .findOne({ access_key: accessKey })
            .lean<SupportLean>();
        if (!item) throw new NotFoundException('Support request not found');
        return this.withAccessFlags(await this.toDetail(item), item, actor);
    }

    async replyStaff(id: string, replyText: string, actor: Actor) {
        if (!this.canManage(actor)) {
            throw new ForbiddenException(
                "You don't have permission to reply to support requests",
            );
        }
        const message = this.assertReplyText(replyText);
        const existing = await this.tickets.findById(id).lean<SupportLean>();
        if (!existing) throw new NotFoundException('Support request not found');
        this.assertCanReply(existing, actor);
        const updated = await this.tickets
            .findByIdAndUpdate(
                existing._id,
                {
                    $push: {
                        replies: {
                            text: message,
                            author_type: 'staff',
                            admin: actor.id,
                            created_date: new Date(),
                        },
                    },
                    $set: { updated_date: new Date() },
                },
                { returnDocument: 'after' },
            )
            .lean<SupportLean>();
        await this.notifyTicketOwner(
            existing,
            {
                type: 'support_reply',
                user: actor.id,
                support_request: existing.access_key,
            },
            {
                title: 'A new reply to your request',
                intro: 'The Scribo team replied to your request. You can read the reply on the request page.',
                message,
            },
        );
        await this.logger.log({
            type: 'reply_support_request',
            message: `User replied to support request ${existing._id}`,
            data: {
                support_request: existing._id,
                access_key: existing.access_key,
                kind: existing.kind,
                user: actor.id,
                author_type: 'staff',
                reply_preview: textPreview(message),
            },
        });
        return this.withAccessFlags(
            await this.toDetail(updated!),
            updated!,
            actor,
        );
    }

    async replyPublic(accessKey: string, replyText: string, actor?: Actor) {
        const message = this.assertReplyText(replyText);
        const existing = await this.tickets
            .findOne({ access_key: accessKey })
            .lean<SupportLean>();
        if (!existing) throw new NotFoundException('Support request not found');
        const authorType = this.assertCanReply(existing, actor);
        const asStaff = authorType === 'staff';
        const updated = await this.tickets
            .findByIdAndUpdate(
                existing._id,
                {
                    $push: {
                        replies: {
                            text: message,
                            author_type: asStaff ? 'staff' : 'requester',
                            admin: asStaff ? actor?.id : null,
                            created_date: new Date(),
                        },
                    },
                    $set: { updated_date: new Date() },
                },
                { returnDocument: 'after' },
            )
            .lean<SupportLean>();
        if (!asStaff) {
            await this.broadcastNewCount();
        }
        if (asStaff) {
            await this.notifyTicketOwner(
                existing,
                {
                    type: 'support_reply',
                    user: actor?.id,
                    support_request: existing.access_key,
                },
                {
                    title: 'A new reply to your request',
                    intro: 'The Scribo team replied to your request. You can read the reply on the request page.',
                    message,
                },
            );
        }
        await this.logger.log({
            type: 'reply_support_request',
            message: asStaff
                ? `User replied to support request ${existing._id}`
                : `Requester replied to support request ${existing._id}`,
            data: {
                support_request: existing._id,
                access_key: existing.access_key,
                kind: existing.kind,
                user: actor?.id,
                author_type: asStaff ? 'staff' : 'requester',
                reply_preview: textPreview(message),
            },
        });
        return this.withAccessFlags(
            await this.toDetail(updated!),
            updated!,
            actor,
        );
    }

    async updateStatus(id: string, supportStatus: string, actor: Actor) {
        if (!this.canManage(actor)) {
            throw new ForbiddenException(
                "You don't have permission to update support request status",
            );
        }
        const nextStatus = this.normalizeStatus(supportStatus);
        if (!STATUS_LABELS[nextStatus]) {
            throw fieldError(
                'supportStatus',
                'Incorrect status!',
                supportStatus,
                HttpStatus.BAD_REQUEST,
            );
        }
        const existing = await this.tickets.findById(id).lean<SupportLean>();
        if (!existing) throw new NotFoundException('Support request not found');
        if (this.normalizeStatus(existing.status) === nextStatus) {
            return this.withAccessFlags(
                await this.toDetail(existing),
                existing,
                actor,
            );
        }
        const updated = await this.tickets
            .findByIdAndUpdate(
                id,
                { $set: { status: nextStatus, updated_date: new Date() } },
                { returnDocument: 'after' },
            )
            .lean<SupportLean>();
        await this.broadcastNewCount();
        const statusLabel = STATUS_LABELS[nextStatus];
        await this.notifyTicketOwner(
            existing,
            {
                type: 'support_status',
                user: actor.id,
                support_request: existing.access_key,
                support_status: nextStatus,
            },
            {
                title: 'Your request status has changed',
                intro: `Request status updated: ${statusLabel}. You can open the request on its page.`,
            },
        );
        await this.logger.log({
            type: 'update_support_status',
            message: `User updated support request ${existing._id} status to ${nextStatus}`,
            data: {
                support_request: existing._id,
                access_key: existing.access_key,
                kind: existing.kind,
                user: actor.id,
                status: nextStatus,
                previous_status: this.normalizeStatus(existing.status),
            },
        });
        return this.withAccessFlags(
            await this.toDetail(updated!),
            updated!,
            actor,
        );
    }
}
