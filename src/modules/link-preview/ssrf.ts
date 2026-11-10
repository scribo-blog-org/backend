import { lookup } from 'dns/promises';
import { isIP } from 'net';

export function isPrivateIpv4(ip: string): boolean {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n))) {
        return true;
    }
    const [a, b, c] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 0 && c === 0) ||
        (a === 192 && b === 168) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224
    );
}

export function isPrivateIpv6(ip: string): boolean {
    const value = ip.toLowerCase();
    if (value === '::' || value === '::1') return true;
    const mapped = value.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIpv4(mapped[1]);
    const mappedHex = value.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
        const hi = parseInt(mappedHex[1], 16);
        const lo = parseInt(mappedHex[2], 16);
        return isPrivateIpv4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
    }
    return (
        value.startsWith('fc') ||
        value.startsWith('fd') ||
        /^fe[89ab]/.test(value) ||
        value.startsWith('ff')
    );
}

export function isPrivateIp(ip: string): boolean {
    const family = isIP(ip);
    if (family === 4) return isPrivateIpv4(ip);
    if (family === 6) return isPrivateIpv6(ip);
    return true;
}

export async function assertPublicUrl(
    url: URL,
    resolve: (host: string) => Promise<string[]> = defaultResolve,
): Promise<void> {
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Unsupported protocol');
    }
    if (url.username || url.password) {
        throw new Error('Credentials in URL are not allowed');
    }
    if (url.port && url.port !== '80' && url.port !== '443') {
        throw new Error('Unsupported port');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (!host || host === 'localhost' || host.endsWith('.localhost')) {
        throw new Error('Private host');
    }
    const addresses = isIP(host) ? [host] : await resolve(host);
    if (!addresses.length || addresses.some((ip) => isPrivateIp(ip))) {
        throw new Error('Private host');
    }
}

async function defaultResolve(host: string): Promise<string[]> {
    const records = await lookup(host, { all: true });
    return records.map((record) => record.address);
}
