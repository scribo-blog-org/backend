import { randomBytes } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

export type RequestMeta = {
    id: string;
    method: string;
    path: string;
    ip: string | null;
    user_agent: string | null;
};

const storage = new AsyncLocalStorage<RequestMeta>();
const dbStorage = new AsyncLocalStorage<DbTimer>();

export type DbTimer = { ms: number };

const USER_AGENT_LIMIT = 200;

export function currentRequest(): RequestMeta | undefined {
    return storage.getStore();
}

export function addDbTime(ms: number) {
    const timer = dbStorage.getStore();
    if (timer) timer.ms += ms;
}

export function requestMeta(req: Request): RequestMeta {
    const agent = req.headers?.['user-agent'];
    return {
        id: randomBytes(6).toString('hex'),
        method: req.method,
        path: (req.originalUrl || req.url || '').split('?')[0],
        ip: req.ip ?? null,
        user_agent:
            typeof agent === 'string' ? agent.slice(0, USER_AGENT_LIMIT) : null,
    };
}

export function requestContextMiddleware(
    req: Request,
    _res: Response,
    next: NextFunction,
) {
    storage.run(requestMeta(req), next);
}

export function requestTimingMiddleware(
    record: (sample: {
        route: string;
        total_ms: number;
        db_ms: number;
    }) => void,
) {
    return (req: Request, res: Response, next: NextFunction) => {
        if (req.method === 'OPTIONS') {
            next();
            return;
        }
        const startedAt = performance.now();
        const timer: DbTimer = { ms: 0 };
        res.on('finish', () => {
            const path = req.route?.path;
            if (typeof path !== 'string') return;
            record({
                route: `${req.method} ${req.baseUrl || ''}${path}`,
                total_ms: performance.now() - startedAt,
                db_ms: timer.ms,
            });
        });
        dbStorage.run(timer, next);
    };
}
