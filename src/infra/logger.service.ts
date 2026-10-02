import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppLog } from '../database/schemas/log.schema';
import { currentRequest } from './request-context';

export type LogActor = {
    id: string;
    nick_name?: string | null;
    role?: string | null;
};

const ERROR_REPEAT_MS = 60_000;
const ERROR_BUDGET_PER_MINUTE = 30;
const STACK_LINES = 30;

@Injectable()
export class LoggerService {
    private readonly errorSeen = new Map<string, number>();
    private budgetStart = 0;
    private budgetUsed = 0;

    constructor(
        @InjectModel(AppLog.name) private readonly logs: Model<AppLog>,
    ) {}

    async log(input: {
        type: string;
        message: string;
        data?: Record<string, unknown> | null;
    }) {
        if (
            typeof input.type !== 'string' ||
            typeof input.message !== 'string'
        ) {
            return;
        }
        try {
            // Запрос, породивший запись, прикладывается сам: id, метод, путь,
            // адрес и браузер. Поля записи его не затирают.
            const request = currentRequest();
            await this.logs.create({
                type: input.type,
                message: input.message,
                data: {
                    ...(request ? { request } : {}),
                    ...(input.data ?? {}),
                },
            });
        } catch (error) {
            console.error(error);
        }
    }

    /**
     * Действие пользователя. Кладёт в запись автора и его ник на тот момент:
     * аккаунт потом могут удалить, а журнал должен остаться читаемым.
     */
    action(
        type: string,
        actor: LogActor,
        data: Record<string, unknown> = {},
        message?: string,
    ) {
        return this.log({
            type,
            message: message ?? `User ${actor.nick_name ?? actor.id}: ${type}`,
            data: {
                user: actor.id,
                user_nick: actor.nick_name ?? null,
                user_role: actor.role ?? null,
                ...data,
            },
        });
    }

    /** Событие самой системы: старт сервера и подобное. Автора нет. */
    system(type: string, message: string, data: Record<string, unknown> = {}) {
        return this.log({ type, message, data: { system: true, ...data } });
    }

    /**
     * Ошибка сервера (5xx). Одинаковая ошибка чаще раза в минуту и больше
     * ERROR_BUDGET_PER_MINUTE записей в минуту не пишутся: иначе упавшая
     * зависимость забила бы базу тысячами одинаковых строк.
     */
    async error(input: {
        status: number;
        method: string;
        path: string;
        message: string;
        stack?: string;
        user?: string | null;
    }) {
        const now = Date.now();
        const key = `${input.method} ${input.path} ${input.message}`;
        const last = this.errorSeen.get(key);
        if (last !== undefined && now - last < ERROR_REPEAT_MS) return;
        if (now - this.budgetStart > 60_000) {
            this.budgetStart = now;
            this.budgetUsed = 0;
        }
        if (this.budgetUsed >= ERROR_BUDGET_PER_MINUTE) return;
        this.budgetUsed += 1;
        this.errorSeen.set(key, now);
        if (this.errorSeen.size > 500) {
            for (const [k, at] of this.errorSeen) {
                if (now - at >= ERROR_REPEAT_MS) this.errorSeen.delete(k);
            }
        }
        await this.system(
            'server_error',
            `${input.status} on ${input.method} ${input.path}: ${input.message}`,
            {
                status: input.status,
                method: input.method,
                path: input.path,
                error: input.message,
                stack: input.stack
                    ? input.stack.split('\n').slice(0, STACK_LINES).join('\n')
                    : null,
                ...(input.user ? { user: input.user } : {}),
            },
        );
    }
}
