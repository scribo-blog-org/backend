import { open } from 'fs/promises';

const HEAD_BYTES = 32;

function ascii(buffer: Buffer, start: number, end: number): string {
    return buffer.subarray(start, end).toString('latin1');
}

export function detectMime(head: Buffer): string | null {
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8) {
        return 'image/jpeg';
    }
    if (
        head.length >= 8 &&
        head
            .subarray(0, 8)
            .equals(
                Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            )
    ) {
        return 'image/png';
    }
    const sig = ascii(head, 0, 6);
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
    if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') {
        return 'image/webp';
    }
    if (
        head.length >= 4 &&
        head[0] === 0x1a &&
        head[1] === 0x45 &&
        head[2] === 0xdf &&
        head[3] === 0xa3
    ) {
        return 'video/webm';
    }
    if (ascii(head, 4, 8) === 'ftyp') {
        const brand = ascii(head, 8, 12);
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
        if (brand === 'qt  ') return 'video/quicktime';
        return 'video/mp4';
    }
    return null;
}

export function mimeMatches(declared: string, detected: string | null) {
    if (!detected) return false;
    if (declared === detected) return true;
    return (
        (declared === 'video/mp4' && detected === 'video/quicktime') ||
        (declared === 'video/quicktime' && detected === 'video/mp4')
    );
}

export async function readHead(filePath: string): Promise<Buffer> {
    const handle = await open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(HEAD_BYTES);
        const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
        return buffer.subarray(0, bytesRead);
    } finally {
        await handle.close();
    }
}
