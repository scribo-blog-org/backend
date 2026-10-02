import { randomBytes } from 'crypto';
import { AsyncLocalStorage } from 'async_hooks';
import type { NextFunction, Request, Response } from 'express';

/**
 * Сведения о запросе, в рамках которого пишется запись журнала. Лежат в
 * AsyncLocalStorage, поэтому сервисам не нужно протаскивать request через
 * все вызовы: журнал сам знает, какой запрос его породил. По id можно
 * сопоставить действие и ошибку, случившуюся в том же запросе.
 */
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
        // Без параметров запроса: в них бывают токены и адреса почты.
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
