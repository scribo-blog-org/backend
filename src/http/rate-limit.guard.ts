import {
    CanActivate,
    ExecutionContext,
    HttpException,
    HttpStatus,
    Injectable,
    SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { clientIp } from '../visitor/geo';

export type RateLimitRule = {
    name: string;
    windowMs: number;
    max: number;
    by?: 'ip' | 'email' | 'user';
};

export const RATE_LIMITS_KEY = 'rate_limits';

export const RateLimits = (...rules: RateLimitRule[]) =>
    SetMetadata(RATE_LIMITS_KEY, rules);

const buckets = new Map<string, { count: number; resetAt: number }>();

function prune(now: number) {
    if (buckets.size < 2000) return;
    for (const [key, bucket] of buckets) {
        if (bucket.resetAt <= now) buckets.delete(key);
    }
}

function consume(key: string, windowMs: number, max: number) {
    const now = Date.now();
    prune(now);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
    }
    bucket.count += 1;
    return bucket.count <= max;
}

export function tryConsume(key: string, windowMs: number, max: number) {
    const now = Date.now();
    prune(now);
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
        bucket = { count: 0, resetAt: now + windowMs };
        buckets.set(key, bucket);
    }
    if (bucket.count >= max) {
        return false;
    }
    bucket.count += 1;
    return true;
}

@Injectable()
export class RateLimitGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext) {
        const rules =
            this.reflector.getAllAndOverride<RateLimitRule[] | undefined>(
                RATE_LIMITS_KEY,
                [context.getHandler(), context.getClass()],
            ) ?? [];
        if (!rules.length) return true;

        const req = context
            .switchToHttp()
            .getRequest<Request & { auth?: { id?: string } }>();
        const ip = clientIp(req) || 'unknown';
        const email = String(
            (req.body as { userEmail?: string } | undefined)?.userEmail || '',
        )
            .trim()
            .toLowerCase();

        const userId = req.auth?.id ? String(req.auth.id) : '';

        for (const rule of rules) {
            const key =
                rule.by === 'email'
                    ? `${rule.name}:email:${email || 'missing'}`
                    : rule.by === 'user'
                      ? `${rule.name}:user:${userId || ip}`
                      : `${rule.name}:ip:${ip}`;
            if (!consume(key, rule.windowMs, rule.max)) {
                throw new HttpException(
                    'Too many requests. Try again later.',
                    HttpStatus.TOO_MANY_REQUESTS,
                );
            }
        }
        return true;
    }
}
