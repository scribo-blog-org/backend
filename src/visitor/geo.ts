const geoCache = new Map<
    string,
    { ip: string; city: string; region: string; country: string }
>();

function normalizeIp(raw: unknown) {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (value.startsWith('::ffff:')) return value.slice(7);
    return value.split('%')[0];
}

function isPrivateIp(ip: string) {
    const normalized = normalizeIp(ip);
    if (
        !normalized ||
        normalized === '127.0.0.1' ||
        normalized === '::1' ||
        normalized === 'localhost'
    ) {
        return true;
    }
    if (normalized.startsWith('10.') || normalized.startsWith('192.168.'))
        return true;
    if (normalized.startsWith('172.')) {
        const second = Number(normalized.split('.')[1]);
        return second >= 16 && second <= 31;
    }
    return false;
}

function firstPublicIp(...candidates: unknown[]) {
    const privateFallback: string[] = [];
    for (const raw of candidates) {
        if (!raw) continue;
        for (const part of String(raw).split(',')) {
            const ip = normalizeIp(part);
            if (!ip) continue;
            if (!isPrivateIp(ip)) return ip;
            privateFallback.push(ip);
        }
    }
    return privateFallback[0] || '';
}

export function clientIp(req: {
    headers?: Record<string, unknown>;
    ip?: string;
    socket?: { remoteAddress?: string };
}) {
    const headers = req.headers || {};
    return firstPublicIp(
        headers['cf-connecting-ip'],
        headers['true-client-ip'],
        headers['x-real-ip'],
        headers['x-forwarded-for'],
        req.ip,
        req.socket?.remoteAddress,
    );
}

export function formatLocation(
    geo: { city?: string; country?: string } | null | undefined,
    fallback: string,
) {
    const parts = [geo?.city, geo?.country].filter(Boolean);
    if (parts.length) {
        return [...new Set(parts)].join(', ');
    }
    return fallback;
}

export async function lookupVisitorGeo(req: {
    headers?: Record<string, unknown>;
    ip?: string;
    socket?: { remoteAddress?: string };
}) {
    const ip = clientIp(req);
    const cacheKey = isPrivateIp(ip) ? `private:${ip || 'none'}` : ip;

    if (geoCache.has(cacheKey)) {
        return {
            ...geoCache.get(cacheKey)!,
            ip: ip || geoCache.get(cacheKey)!.ip,
        };
    }

    if (isPrivateIp(ip)) {
        const empty = { ip, city: '', region: '', country: '' };
        geoCache.set(cacheKey, empty);
        return empty;
    }

    try {
        const response = await fetch(
            `https://ipwho.is/${encodeURIComponent(ip)}`,
            {
                signal: AbortSignal.timeout(2000),
                headers: { 'User-Agent': 'scribo-session' },
            },
        );
        const data = (await response.json()) as {
            success?: boolean;
            ip?: string;
            city?: string;
            region?: string;
            country?: string;
        };
        if (data?.success) {
            const result = {
                ip: ip || data.ip || '',
                city: data.city || '',
                region: data.region || '',
                country: data.country || '',
            };
            geoCache.set(cacheKey, result);
            return result;
        }
    } catch {
        void 0;
    }

    const fallback = { ip, city: '', region: '', country: '' };
    geoCache.set(cacheKey, fallback);
    return fallback;
}
