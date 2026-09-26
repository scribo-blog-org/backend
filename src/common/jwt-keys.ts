import * as crypto from 'crypto';

function parseJwk(raw: string): crypto.JsonWebKey {
    const trimmed = unwrap(raw);
    try {
        return JSON.parse(trimmed) as crypto.JsonWebKey;
    } catch (error) {
        const unescaped = trimmed.replace(/\\"/g, '"');
        if (unescaped === trimmed) {
            throw error;
        }
        return JSON.parse(unescaped) as crypto.JsonWebKey;
    }
}

function unwrap(raw: string): string {
    const trimmed = raw.trim();
    if (
        (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
        (trimmed.startsWith('"') && trimmed.endsWith('"'))
    ) {
        return trimmed.slice(1, -1);
    }
    return trimmed;
}

function material(raw: string): string {
    return unwrap(raw).replace(/\\n/g, '\n');
}

export function privateKeyFromEnv(raw: string): crypto.KeyObject {
    const value = material(raw);
    if (value.startsWith('{')) {
        return crypto.createPrivateKey({ key: parseJwk(value), format: 'jwk' });
    }
    return crypto.createPrivateKey(value);
}

export function publicKeyFromEnv(raw: string): crypto.KeyObject {
    const value = material(raw);
    if (value.startsWith('{')) {
        return crypto.createPublicKey({ key: parseJwk(value), format: 'jwk' });
    }
    return crypto.createPublicKey(value);
}

const pemCache = new Map<string, string>();

export function publicKeyPem(raw: string): string {
    const cached = pemCache.get(raw);
    if (cached) return cached;
    const exported = publicKeyFromEnv(raw).export({
        type: 'spki',
        format: 'pem',
    });
    const pem = typeof exported === 'string' ? exported : exported.toString();
    pemCache.set(raw, pem);
    return pem;
}

export function assertKeyPair(privateRaw: string, publicRaw: string) {
    const fromPrivate = crypto
        .createPublicKey(privateKeyFromEnv(privateRaw))
        .export({ type: 'spki', format: 'der' });
    const fromPublic = publicKeyFromEnv(publicRaw).export({
        type: 'spki',
        format: 'der',
    });
    if (!Buffer.from(fromPrivate).equals(Buffer.from(fromPublic))) {
        throw new Error('JWT_PUBLIC_KEY does not match JWT_PRIVATE_KEY');
    }
}
