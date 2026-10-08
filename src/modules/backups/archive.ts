import { createReadStream } from 'fs';
import { mkdir, stat } from 'fs/promises';
import path from 'path';
import { Writable } from 'stream';
import { pipeline } from 'stream/promises';
import { createGunzip } from 'zlib';
import { incompatibility } from './db-version';
import {
    MANIFEST_FILE,
    MONGO_ARCHIVE,
    dirStats,
    manifestDbVersion,
    parseManifest,
    sha256File,
    type Manifest,
} from './manifest';
import { runProcess } from './run-process';
import {
    ArchiveError,
    readEntry,
    scanTar,
    type TarEntry,
    type TarLimits,
} from './tar-scan';

export { ArchiveError } from './tar-scan';

const MANIFEST_MAX_BYTES = 1024 * 1024;
const MONGODUMP_MAGIC = Buffer.from([0x6d, 0xe2, 0x99, 0x81]);

export type VerifyOptions = {
    tar: string;
    file: string;
    work: string;
    dbVersion: string | null;
    expectedId?: string;
    limits: TarLimits;
};

function checkLayout(entries: TarEntry[], manifest: Manifest) {
    const seen = new Set<string>();
    const dir = manifest.uploads.dir;
    let dump: TarEntry | null = null;
    let files = 0;
    let bytes = 0;
    for (const entry of entries) {
        const parent = path.posix.dirname(entry.path);
        if (
            entry.type === 'file' &&
            path.posix.basename(entry.path).startsWith('._') &&
            (parent === '.' || parent === dir || parent.startsWith(`${dir}/`))
        ) {
            continue;
        }
        if (seen.has(entry.path)) {
            throw new ArchiveError(`"${entry.path}" is in the archive twice`);
        }
        seen.add(entry.path);
        if (entry.path === MANIFEST_FILE || entry.path === MONGO_ARCHIVE) {
            if (entry.type !== 'file') {
                throw new ArchiveError(`${entry.path} must be a file`);
            }
            if (entry.path === MONGO_ARCHIVE) dump = entry;
        } else if (entry.path === dir) {
            if (entry.type !== 'dir') {
                throw new ArchiveError(`${dir} must be a directory`);
            }
        } else if (entry.path.startsWith(`${dir}/`)) {
            if (entry.type === 'file') {
                files += 1;
                bytes += entry.size;
            }
        } else {
            throw new ArchiveError(
                `Unexpected "${entry.path}" in the archive: it is not a Scribo backup`,
            );
        }
    }
    if (!dump) throw new ArchiveError('The database dump is missing');
    if (dump.size !== manifest.db.bytes) {
        throw new ArchiveError('The database dump has a wrong size');
    }
    if (files !== manifest.uploads.files || bytes !== manifest.uploads.bytes) {
        throw new ArchiveError(
            'The uploads in the archive do not match the manifest',
        );
    }
}

export async function verifyArchive(opts: VerifyOptions): Promise<Manifest> {
    const entries = await scanTar(opts.file, opts.limits);
    const entry = entries.find((item) => item.path === MANIFEST_FILE);
    if (!entry || entry.type !== 'file') {
        throw new ArchiveError('manifest.json is missing: not a Scribo backup');
    }
    const manifest = parseManifest(
        (await readEntry(opts.file, entry, MANIFEST_MAX_BYTES)).toString(
            'utf8',
        ),
    );
    if (opts.expectedId !== undefined && manifest.id !== opts.expectedId) {
        throw new ArchiveError('The manifest belongs to a different backup');
    }
    const mismatch = incompatibility(
        manifestDbVersion(manifest),
        opts.dbVersion,
    );
    if (mismatch) throw new ArchiveError(mismatch);
    checkLayout(entries, manifest);

    await mkdir(opts.work, { recursive: true, mode: 0o700 });
    await runProcess(opts.tar, [
        '--exclude=._*',
        '-xf',
        opts.file,
        '-C',
        opts.work,
    ]);

    const dump = path.join(opts.work, MONGO_ARCHIVE);
    const dumpSize = await stat(dump)
        .then((s) => s.size)
        .catch(() => -1);
    if (dumpSize !== manifest.db.bytes) {
        throw new ArchiveError(
            'The database dump is missing or has a wrong size',
        );
    }
    if ((await sha256File(dump)) !== manifest.db.sha256) {
        throw new ArchiveError('The database dump checksum does not match');
    }
    const uploads = await dirStats(path.join(opts.work, manifest.uploads.dir));
    if (
        uploads.files !== manifest.uploads.files ||
        uploads.bytes !== manifest.uploads.bytes
    ) {
        throw new ArchiveError(
            'The uploads in the archive do not match the manifest',
        );
    }
    return manifest;
}

export async function checkMongoDump(file: string): Promise<void> {
    let head = Buffer.alloc(0);
    const sink = new Writable({
        write(chunk: Buffer, _encoding, done) {
            if (head.length < MONGODUMP_MAGIC.length) {
                head = Buffer.concat([head, chunk]).subarray(
                    0,
                    MONGODUMP_MAGIC.length,
                );
            }
            done();
        },
    });
    try {
        await pipeline(createReadStream(file), createGunzip(), sink);
    } catch {
        throw new ArchiveError('The database dump is not a valid gzip stream');
    }
    if (!head.equals(MONGODUMP_MAGIC)) {
        throw new ArchiveError('The database dump is not a mongodump archive');
    }
}
