import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AppLog } from '../database/schemas/log.schema';
import {
    currentRequest,
    requestTiming,
    type RequestSample,
} from './request-context';
import type { SlowQuery } from '../database/db-timing.plugin';

export type LogActor = {
    id: string;
    nick_name?: string | null;
    role?: string | null;
    avatar?: string | null;
};

export type LogLevel = 'info' | 'warn' | 'error';

export const actorFields = (actor: LogActor) => ({
    user: actor.id,
    user_nick: actor.nick_name ?? null,
    user_role: actor.role ?? null,
    user_avatar: actor.avatar ?? null,
});

const ERROR_REPEAT_MS = 60_000;
const ERROR_BUDGET_PER_MINUTE = 30;
const STACK_LINES = 30;
const DIAGNOSTIC_REPEAT_MS = 30_000;
const DIAGNOSTIC_BUDGET_PER_MINUTE = 60;
const MAX_TRACKED_KEYS = 500;
const SLOW_REQUEST_MS = Number(process.env.SLOW_REQUEST_MS) || 1000;
// Backups and restores are long by design, health checks and analytics pings
// are not worth a row.
const SLOW_REQUEST_IGNORED = [
    /^[A-Z]+ \/health/,
    /^[A-Z]+ \/api\/analytics\//,
    /^[A-Z]+ \/api\/backups/,
    /^[A-Z]+ \(no route\)$/,
];

const seconds = (ms: number) =>
    ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;

type Seen = { at: number; skipped: number };

export type DiagnosticInput = {
    type: string;
    message: string;
    level?: LogLevel;
    data?: Record<string, unknown>;
    key: string;
};

@Injectable()
export class LoggerService {
    private readonly errorSeen = new Map<string, Seen>();
    private readonly diagnosticSeen = new Map<string, Seen>();
    private budgetStart = 0;
    private budgetUsed = 0;
    private diagnosticStart = 0;
    private diagnosticUsed = 0;

    constructor(
        @InjectModel(AppLog.name) private readonly logs: Model<AppLog>,
    ) {}

    async log(input: {
        type: string;
        message: string;
        level?: LogLevel;
        data?: Record<string, unknown> | null;
    }) {
        if (
            typeof input.type !== 'string' ||
            typeof input.message !== 'string'
        ) {
            return;
        }
        try {
            const request = currentRequest();
            await this.logs.create({
                type: input.type,
                message: input.message,
                level: input.level ?? 'info',
                data: {
                    ...(request ? { request } : {}),
                    ...(input.data ?? {}),
                },
            });
        } catch (error) {
            console.error(error);
        }
    }

    action(
        type: string,
        actor: LogActor,
        data: Record<string, unknown> = {},
        message?: string,
        level?: LogLevel,
    ) {
        return this.log({
            type,
            message: message ?? `User ${actor.nick_name ?? actor.id}: ${type}`,
            level,
            data: {
                ...actorFields(actor),
                ...data,
            },
        });
    }

    system(
        type: string,
        message: string,
        data: Record<string, unknown> = {},
        level?: LogLevel,
    ) {
        return this.log({
            type,
            message,
            level,
            data: { system: true, ...data },
        });
    }

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
        if (last !== undefined && now - last.at < ERROR_REPEAT_MS) {
            last.skipped += 1;
            return;
        }
        if (now - this.budgetStart > 60_000) {
            this.budgetStart = now;
            this.budgetUsed = 0;
        }
        if (this.budgetUsed >= ERROR_BUDGET_PER_MINUTE) return;
        this.budgetUsed += 1;
        const repeats = last?.skipped ?? 0;
        this.errorSeen.set(key, { at: now, skipped: 0 });
        this.prune(this.errorSeen, ERROR_REPEAT_MS, now);
        const timing = requestTiming();
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
                ...(repeats ? { repeats } : {}),
                ...(timing
                    ? {
                          total_ms: Math.round(timing.total_ms),
                          db_ms: Math.round(timing.db_ms),
                          db_queries: timing.db_queries,
                      }
                    : {}),
            },
            'error',
        );
    }

    externalFailed(service: string, error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return this.diagnostic({
            type: 'external_failed',
            message: `${service} failed: ${message}`,
            key: `external_failed|${service}|${message}`,
            data: { system: true, service, error: message.slice(0, 300) },
        });
    }

    slowRequest(sample: RequestSample) {
        if (sample.total_ms < SLOW_REQUEST_MS) return;
        if (SLOW_REQUEST_IGNORED.some((rule) => rule.test(sample.route))) {
            return;
        }
        return this.diagnostic({
            type: 'slow_request',
            message: `${sample.route} took ${seconds(sample.total_ms)}`,
            key: `slow_request|${sample.route}`,
            data: {
                route: sample.route,
                method: sample.method,
                path: sample.path,
                status: sample.status,
                total_ms: Math.round(sample.total_ms),
                db_ms: Math.round(sample.db_ms),
                db_queries: sample.db_queries,
                ...(sample.user ? { user: sample.user } : { system: true }),
            },
        });
    }

    slowQuery(query: SlowQuery) {
        const shape = JSON.stringify(query.filter ?? null);
        return this.diagnostic({
            type: 'slow_query',
            message: `${query.collection}.${query.op} took ${seconds(query.ms)}`,
            key: `slow_query|${query.collection}|${query.op}|${shape}`,
            data: {
                system: true,
                collection: query.collection,
                operation: query.op,
                duration_ms: Math.round(query.ms),
                filter: shape.length > 300 ? `${shape.slice(0, 300)}…` : shape,
            },
        });
    }

    private prune(seen: Map<string, Seen>, windowMs: number, now: number) {
        if (seen.size <= MAX_TRACKED_KEYS) return;
        for (const [key, entry] of seen) {
            if (now - entry.at >= windowMs) seen.delete(key);
        }
    }

    // Warnings about requests that are expected to repeat in bursts (failed
    // logins, rate limits, denied access): one row per key per window, with
    // the number of skipped repeats attached to the next row.
    async diagnostic(input: DiagnosticInput) {
        const now = Date.now();
        const last = this.diagnosticSeen.get(input.key);
        if (last && now - last.at < DIAGNOSTIC_REPEAT_MS) {
            last.skipped += 1;
            return;
        }
        if (now - this.diagnosticStart > 60_000) {
            this.diagnosticStart = now;
            this.diagnosticUsed = 0;
        }
        if (this.diagnosticUsed >= DIAGNOSTIC_BUDGET_PER_MINUTE) return;
        this.diagnosticUsed += 1;
        this.diagnosticSeen.set(input.key, { at: now, skipped: 0 });
        this.prune(this.diagnosticSeen, DIAGNOSTIC_REPEAT_MS, now);
        await this.log({
            type: input.type,
            message: input.message,
            level: input.level ?? 'warn',
            data: {
                ...(input.data ?? {}),
                ...(last?.skipped ? { repeats: last.skipped } : {}),
            },
        });
    }
}
