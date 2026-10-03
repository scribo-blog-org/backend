import type { Request, Response } from 'express';

export const REFRESH_COOKIE = 'refresh_token';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function cookieOptions(req?: Request) {
    const forwarded = String(req?.headers?.['x-forwarded-proto'] || '')
        .split(',')[0]
        .trim();
    const secure = forwarded === 'https' || Boolean(req?.secure);
    return {
        httpOnly: true,
        secure,
        sameSite: (secure ? 'none' : 'lax') as 'none' | 'lax',
        path: '/',
        maxAge: MAX_AGE_MS,
        ...(secure ? { partitioned: true as const } : {}),
    };
}

export function getRefreshCookies(cookieHeader?: string) {
    const tokens: string[] = [];
    for (const part of String(cookieHeader || '').split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        const name = part.slice(0, index).trim();
        if (name !== REFRESH_COOKIE) continue;
        let value = part.slice(index + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
        }
        try {
            value = decodeURIComponent(value);
        } catch {
            void 0;
        }
        if (value) tokens.push(value);
    }
    return tokens.reverse();
}

function clearStaleRefreshCookies(res: Response) {
    const variants = [
        { path: '/api/auth', sameSite: 'lax' as const, secure: false },
        { path: '/api/auth', sameSite: 'lax' as const, secure: true },
        { path: '/api/auth', sameSite: 'none' as const, secure: true },
        { path: '/', sameSite: 'lax' as const, secure: false },
        { path: '/', sameSite: 'lax' as const, secure: true },
    ];

    for (const variant of variants) {
        res.clearCookie(REFRESH_COOKIE, { httpOnly: true, ...variant });
    }
}

export function setRefreshCookie(res: Response, token: string, req?: Request) {
    clearStaleRefreshCookies(res);
    res.cookie(REFRESH_COOKIE, token, cookieOptions(req));
}

export function clearRefreshCookie(res: Response, req?: Request) {
    clearStaleRefreshCookies(res);
    res.clearCookie(REFRESH_COOKIE, cookieOptions(req));
}
