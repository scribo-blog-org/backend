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

const USER_AGENT_LIMIT = 200;

export function currentRequest(): RequestMeta | undefined {
    return storage.getStore();
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
