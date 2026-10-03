import { open } from 'fs/promises';

const BLOCK = 512;
const META_LIMIT = 1024 * 1024;

export type TarEntry = {
    path: string;
    type: 'file' | 'dir';
    size: number;
    dataOffset: number;
};

export class ArchiveError extends Error {}

export type TarLimits = {
    maxEntries: number;
    maxBytes: number;
};

function octal(field: Buffer): number {
    if (field[0] & 0x80) {
        let value = field[0] & 0x7f;
        for (let i = 1; i < field.length; i++) value = value * 256 + field[i];
        return value;
    }
    const text = field.toString('latin1').replace(/\0.*$/, '').trim();
    if (text === '') return 0;
    if (!/^[0-7]+$/.test(text)) throw new ArchiveError('Not a tar archive');
    return parseInt(text, 8);
}

function text(field: Buffer): string {
    return field.toString('utf8').replace(/\0.*$/s, '');
}

function validChecksum(header: Buffer): boolean {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
        sum += i >= 148 && i < 156 ? 0x20 : header[i];
    }
    return sum === octal(header.subarray(148, 156));
}

function paxRecords(data: Buffer): Record<string, string> {
    const result: Record<string, string> = {};
    let pos = 0;
    while (pos < data.length) {
        const space = data.indexOf(0x20, pos);
        if (space === -1) break;
        const length = parseInt(data.toString('latin1', pos, space), 10);
        if (!Number.isInteger(length) || length <= 0) {
            throw new ArchiveError('Not a tar archive');
        }
        const record = data.toString('utf8', space + 1, pos + length - 1);
        const eq = record.indexOf('=');
        if (eq > 0) result[record.slice(0, eq)] = record.slice(eq + 1);
        pos += length;
    }
    return result;
}

export function cleanEntryPath(raw: string): string {
    const name = raw.replace(/^(\.\/)+/, '').replace(/\/+$/, '');
    if (
        !name ||
        name.startsWith('/') ||
        name.includes('\0') ||
        name.includes('\\') ||
        name.split('/').some((part) => part === '..' || part === '.')
    ) {
        throw new ArchiveError(`The archive has an unsafe path: "${raw}"`);
    }
    return name;
}

export async function scanTar(
    file: string,
    limits: TarLimits,
): Promise<TarEntry[]> {
    const handle = await open(file, 'r');
    try {
        const total = (await handle.stat()).size;
        const entries: TarEntry[] = [];
        let bytes = 0;
        let offset = 0;
        let nextPath: string | null = null;
        let nextSize: number | null = null;

        const read = async (at: number, length: number) => {
            const buffer = Buffer.alloc(length);
            const { bytesRead } = await handle.read(buffer, 0, length, at);
            if (bytesRead !== length) {
                throw new ArchiveError('The archive is truncated');
            }
            return buffer;
        };

        while (offset < total) {
            const header = await read(offset, BLOCK);
            if (header.every((byte) => byte === 0)) break;
            if (!validChecksum(header)) {
                throw new ArchiveError('Not a tar archive');
            }
            const flag = String.fromCharCode(header[156] || 0x30);
            let size = octal(header.subarray(124, 136));
            const dataOffset = offset + BLOCK;

            if (flag === 'x' || flag === 'L' || flag === 'g') {
                if (size > META_LIMIT) {
                    throw new ArchiveError(
                        'The archive has an oversized header',
                    );
                }
                const data = await read(dataOffset, size);
                if (flag === 'x') {
                    const pax = paxRecords(data);
                    if (pax.path !== undefined) nextPath = pax.path;
                    if (pax.size !== undefined) nextSize = Number(pax.size);
                } else if (flag === 'L') {
                    nextPath = text(data);
                }
            } else if (flag !== 'K') {
                const usesPrefix =
                    header.toString('latin1', 257, 262) === 'ustar' &&
                    header[262] === 0;
                const prefix = usesPrefix
                    ? text(header.subarray(345, 500))
                    : '';
                const name = text(header.subarray(0, 100));
                const raw = nextPath ?? (prefix ? `${prefix}/${name}` : name);
                if (nextSize !== null) size = nextSize;
                nextPath = null;
                nextSize = null;

                if (!Number.isFinite(size) || size < 0) {
                    throw new ArchiveError('Not a tar archive');
                }
                const type =
                    flag === '0' ? 'file' : flag === '5' ? 'dir' : null;
                if (!type) {
                    throw new ArchiveError(
                        `The archive has an unsupported entry (links and special files are not allowed): "${raw}"`,
                    );
                }
                if (entries.length >= limits.maxEntries) {
                    throw new ArchiveError('The archive has too many files');
                }
                bytes += type === 'file' ? size : 0;
                if (bytes > limits.maxBytes) {
                    throw new ArchiveError(
                        'The archive is too large when unpacked',
                    );
                }
                if (type === 'dir' && /^(\.\/?)+$/.test(raw)) {
                    offset = dataOffset;
                    continue;
                }
                entries.push({
                    path: cleanEntryPath(raw),
                    type,
                    size: type === 'file' ? size : 0,
                    dataOffset,
                });
            }
            offset = dataOffset + Math.ceil(size / BLOCK) * BLOCK;
            if (offset > total)
                throw new ArchiveError('The archive is truncated');
        }
        return entries;
    } finally {
        await handle.close();
    }
}

export async function readEntry(
    file: string,
    entry: TarEntry,
    maxBytes: number,
): Promise<Buffer> {
    if (entry.size > maxBytes) {
        throw new ArchiveError(`${entry.path} is too large`);
    }
    const handle = await open(file, 'r');
    try {
        const buffer = Buffer.alloc(entry.size);
        const { bytesRead } = await handle.read(
            buffer,
            0,
            entry.size,
            entry.dataOffset,
        );
        if (bytesRead !== entry.size) {
            throw new ArchiveError('The archive is truncated');
        }
        return buffer;
    } finally {
        await handle.close();
    }
}
