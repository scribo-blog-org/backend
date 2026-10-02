import { createHash } from 'crypto';
import { createReadStream } from 'fs';
import { readdir, stat } from 'fs/promises';
import path from 'path';
import { dbVersionOf } from './db-version';

export const MANIFEST_VERSION = 1;
export const MANIFEST_FILE = 'manifest.json';
export const MONGO_ARCHIVE = 'mongo.archive.gz';

export type BackupKind = 'daily' | 'pre_restore';

/**
 * Паспорт архива. Лежит внутри самого .tar и связывает дамп базы и каталог
 * загрузок: по нему проверяется, что архив целый, и из него видно, чем он был.
 */
export type Manifest = {
    format: number;
    /** Совпадает с _id записи в истории бекапов. */
    id: string;
    created_at: string;
    day: string;
    kind: BackupKind;
    trigger: 'schedule' | 'manual' | 'restore';
    app_version: string;
    /** На каком бекапе стояла система, когда сняли этот архив. */
    based_on: string | null;
    db: {
        name: string;
        archive: string;
        sha256: string;
        bytes: number;
        collections: string[];
        /** Версия данных (см. db-version.ts). Нет в архивах, снятых до версий. */
        version?: string | null;
    };
    uploads: { dir: string; files: number; bytes: number };
};

export function parseManifest(raw: string): Manifest {
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        throw new Error('manifest.json is not valid JSON');
    }
    const m = value as Partial<Manifest> | null;
    if (
        !m ||
        m.format !== MANIFEST_VERSION ||
        typeof m.id !== 'string' ||
        typeof m.created_at !== 'string' ||
        typeof m.day !== 'string' ||
        (m.kind !== 'daily' && m.kind !== 'pre_restore') ||
        typeof m.db?.name !== 'string' ||
        m.db.archive !== MONGO_ARCHIVE ||
        !/^[a-f0-9]{64}$/.test(m.db.sha256 ?? '') ||
        !Array.isArray(m.db.collections) ||
        (m.db.version !== undefined &&
            m.db.version !== null &&
            typeof m.db.version !== 'string') ||
        typeof m.uploads?.dir !== 'string' ||
        !/^[\w.-]+$/.test(m.uploads.dir) ||
        m.uploads.dir === '.' ||
        m.uploads.dir === '..' ||
        typeof m.uploads.files !== 'number' ||
        typeof m.uploads.bytes !== 'number'
    ) {
        throw new Error('manifest.json has an unsupported shape');
    }
    return m as Manifest;
}

/** Версия данных архива. У старых архивов без неё берём из версии backend, которой он снят. */
export function manifestDbVersion(manifest: Manifest): string | null {
    return manifest.db.version ?? dbVersionOf(manifest.app_version);
}

export function sha256File(file: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const hash = createHash('sha256');
        createReadStream(file)
            .on('data', (chunk) => hash.update(chunk))
            .on('error', reject)
            .on('end', () => resolve(hash.digest('hex')));
    });
}

/** Сколько обычных файлов и байт в каталоге, включая вложенные. */
export async function dirStats(
    dir: string,
): Promise<{ files: number; bytes: number }> {
    let files = 0;
    let bytes = 0;
    const entries = await readdir(dir, { withFileTypes: true }).catch(
        (error: NodeJS.ErrnoException) => {
            if (error.code === 'ENOENT') return [];
            throw error;
        },
    );
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const inner = await dirStats(full);
            files += inner.files;
            bytes += inner.bytes;
        } else if (entry.isFile()) {
            files += 1;
            bytes += (await stat(full)).size;
        }
    }
    return { files, bytes };
}

export function appVersion(): string {
    try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pkg = require(path.join(process.cwd(), 'package.json')) as {
            version?: string;
        };
        return pkg.version ?? 'unknown';
    } catch {
        return 'unknown';
    }
}
