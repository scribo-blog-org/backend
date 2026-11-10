import { randomBytes } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

export type RequestMeta = {
    id: string;
    method: string;
    path: string;
    ip: string | null;
    user_agent: string | null;
    trace_id: string | null;
};

export type DbTimer = {
    startedAt: number;
    intervals: Array<[number, number]>;
    queries: number;
};

export type RequestSample = {
    route: string;
    status: number;
    total_ms: number;
    db_ms: number;
    db_queries: number;
    user: string | null;
    method: string;
    path: string;
    request_id: string | null;
    trace_id?: string | null;
    error?: string | null;
    query?: Record<string, string> | null;
};

const storage = new AsyncLocalStorage<RequestMeta>();
const dbStorage = new AsyncLocalStorage<DbTimer>();

const USER_AGENT_LIMIT = 200;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;

export function currentRequest(): RequestMeta | undefined {
    return storage.getStore();
}

export function addDbQuery(startedAt: number, endedAt = performance.now()) {
    const timer = dbStorage.getStore();
    if (!timer) return;
    timer.queries += 1;
    timer.intervals.push([startedAt, endedAt]);
}

export function unionMs(intervals: Array<[number, number]>) {
    const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
    let total = 0;
    let [start, end] = sorted[0] ?? [0, 0];
    for (const [from, to] of sorted.slice(1)) {
        if (from > end) {
            total += end - start;
            start = from;
            end = to;
        } else if (to > end) {
            end = to;
        }
    }
    return total + (end - start);
}

export function requestTiming() {
    const timer = dbStorage.getStore();
    if (!timer) return undefined;
    const total = performance.now() - timer.startedAt;
    return {
        total_ms: total,
        db_ms: Math.min(unionMs(timer.intervals), total),
        db_queries: timer.queries,
    };
}

export function requestMeta(req: Request): RequestMeta {
    const agent = req.headers?.['user-agent'];
    const incoming = req.headers?.['x-request-id'];
    const trace = req.headers?.['x-trace-id'];
    const id =
        typeof incoming === 'string' && REQUEST_ID_PATTERN.test(incoming)
            ? incoming
            : randomBytes(6).toString('hex');
    return {
        id,
        method: req.method,
        path: (req.originalUrl || req.url || '').split('?')[0],
        ip: req.ip ?? null,
        user_agent:
            typeof agent === 'string' ? agent.slice(0, USER_AGENT_LIMIT) : null,
        trace_id:
            typeof trace === 'string' && REQUEST_ID_PATTERN.test(trace)
                ? trace
                : id,
    };
}

export function requestContextMiddleware(
    req: Request,
    res: Response,
    next: NextFunction,
) {
    const meta = requestMeta(req);
    res.setHeader('X-Request-Id', meta.id);
    storage.run(meta, next);
}

const SENSITIVE_QUERY =
    /pass|secret|token|auth|cookie|key|signature|code|email/i;

export function queryOfUrl(url: string): Record<string, string> | null {
    const index = url.indexOf('?');
    if (index < 0) return null;
    const out: Record<string, string> = {};
    let count = 0;
    for (const [key, value] of new URLSearchParams(url.slice(index + 1))) {
        if (count++ >= 20) break;
        const name = key.slice(0, 60);
        const safe = SENSITIVE_QUERY.test(key)
            ? '[redacted]'
            : value.slice(0, 120);
        out[name] = name in out ? `${out[name]},${safe}` : safe;
    }
    return Object.keys(out).length ? out : null;
}

export function requestTimingMiddleware(
    record: (sample: RequestSample) => void,
) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.method === 'OPTIONS') {
            next();
            return;
        }
        const timer: DbTimer = {
            startedAt: performance.now(),
            intervals: [],
            queries: 0,
        };
        const meta = currentRequest();
        res.on('finish', () => {
            const path = req.route?.path;
            const total = performance.now() - timer.startedAt;
            const auth = (req as { auth?: { id?: string } }).auth;
            record({
                route:
                    typeof path === 'string'
                        ? `${req.method} ${req.baseUrl || ''}${path}`
                        : `${req.method} (no route)`,
                status: res.statusCode,
                total_ms: total,
                db_ms: Math.min(unionMs(timer.intervals), total),
                db_queries: timer.queries,
                user: auth?.id ? String(auth.id) : null,
                method: req.method,
                path: meta?.path ?? (req.originalUrl || '').split('?')[0],
                request_id: meta?.id ?? null,
                trace_id: meta?.trace_id ?? null,
                query: queryOfUrl(req.originalUrl || ''),
                error:
                    typeof res.locals?.error_message === 'string'
                        ? res.locals.error_message
                        : null,
            });
        });
        dbStorage.run(timer, next);
    };
}
