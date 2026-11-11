import { Injectable } from '@nestjs/common';
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join, resolve } from 'path';
import { gunzipSync } from 'zlib';
import type { RuntimeLevel } from '../../infra/runtime-log';

export const RUNTIME_SOURCES = {
    backend: { dir: 'backend', prefix: 'backend' },
    socket: { dir: 'socket', prefix: 'socket' },
    frontend: { dir: 'frontend', prefix: 'frontend' },
} as const;

export type RuntimeSource = keyof typeof RUNTIME_SOURCES;

export const isRuntimeSource = (value: unknown): value is RuntimeSource =>
    typeof value === 'string' &&
    Object.prototype.hasOwnProperty.call(RUNTIME_SOURCES, value);

export type RuntimeEntry = {
    ts: string;
    level: RuntimeLevel;
    service: string;
    msg: string;
    data: Record<string, unknown>;
};

export type RuntimeQuery = {
    source?: RuntimeSource;
    sources?: RuntimeSource[];
    level?: string;
    q?: string;
    from?: string;
    to?: string;
    before?: string;
    after?: string;
    status?: number;
    min_ms?: number;
    max_ms?: number;
    limit?: number;
};

export type RuntimePage = {
    items: RuntimeEntry[];
    // cursor for older entries (`before`), null when there are none
    next: string | null;
    // cursor for newer entries (`after`), null when the page starts at the
    // newest entry
    prev?: string | null;
    available: boolean;
};

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 100;
const LEVELS = new Set(['debug', 'info', 'warn', 'error']);

export const runtimeLogRoot = (env: NodeJS.ProcessEnv = process.env) =>
    env.LOG_ROOT || env.LOG_DIR || '';

export function parseRuntimeLine(
    line: string,
    source: RuntimeSource,
): RuntimeEntry | null {
    const text = line.trim();
    if (!text) return null;
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(text) as Record<string, unknown>;
    } catch {
        return null;
    }
    const { ts, level, service, msg, ...data } = raw;
    if (typeof ts !== 'string' || Number.isNaN(Date.parse(ts))) return null;
    return {
        ts: new Date(ts).toISOString(),
        level: LEVELS.has(String(level)) ? (level as RuntimeLevel) : 'info',
        service: typeof service === 'string' ? service : source,
        msg: typeof msg === 'string' ? msg : '',
        data,
    };
}

export function listLogFiles(dir: string, prefix: string): string[] {
    if (!existsSync(dir)) return [];
    const rotated = readdirSync(dir)
        .filter(
            (name) =>
                name.startsWith(`${prefix}-`) &&
                (name.endsWith('.log') || name.endsWith('.log.gz')),
        )
        .map((name) => ({
            path: join(dir, name),
            mtime: statSync(join(dir, name)).mtimeMs,
        }))
        .sort((a, b) => b.mtime - a.mtime)
        .map((file) => file.path);
    const current = join(dir, `${prefix}.log`);
    return existsSync(current) ? [current, ...rotated] : rotated;
}

function readLines(path: string): string[] {
    const buffer = readFileSync(path);
    const text = path.endsWith('.gz')
        ? gunzipSync(buffer).toString('utf8')
        : buffer.toString('utf8');
    return text.split('\n');
}

function readOne(
    root: string,
    source: RuntimeSource,
    query: RuntimeQuery,
): RuntimePage {
    const config = RUNTIME_SOURCES[source];
    const dir = resolve(root, config.dir);
    const files = listLogFiles(dir, config.prefix);
    if (files.length === 0) {
        return { items: [], next: null, available: existsSync(dir) };
    }
    const limit = Math.min(
        Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1),
        MAX_LIMIT,
    );
    const levels = query.level
        ? new Set(query.level.split(',').filter((l) => LEVELS.has(l)))
        : null;
    const needle = query.q?.trim().toLowerCase() || null;
    const from = query.from ? Date.parse(query.from) : null;
    const to = query.to ? Date.parse(query.to) : null;
    const before = query.before ? Date.parse(query.before) : null;
    const after = query.after ? Date.parse(query.after) : null;
    const items: RuntimeEntry[] = [];
    let more = false;
    let reachedCursor = false;

    for (const file of files) {
        if (from !== null && statSync(file).mtimeMs < from) break;
        const lines = readLines(file);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const line = lines[i];
            if (needle && !line.toLowerCase().includes(needle)) continue;
            const entry = parseRuntimeLine(line, source);
            if (!entry) continue;
            const time = Date.parse(entry.ts);
            // newest first: once the cursor is reached everything else is older
            if (after !== null && time <= after) {
                reachedCursor = true;
                break;
            }
            if (before !== null && time >= before) continue;
            if (to !== null && time > to) continue;
            if (from !== null && time < from) continue;
            if (levels && levels.size > 0 && !levels.has(entry.level)) continue;
            if (!matchesMetrics(entry, query)) continue;
            if (after === null && items.length >= limit) {
                more = true;
                break;
            }
            items.push(entry);
        }
        if (more || reachedCursor) break;
    }

    if (after !== null) {
        // everything newer than the cursor, newest first: keep the entries
        // nearest to it, the rest is reached by the next `after` request
        const hasNewer = items.length > limit;
        const page = items.slice(-limit);
        return {
            items: page,
            next: null,
            prev: hasNewer && page.length > 0 ? page[0].ts : null,
            available: true,
        };
    }

    return {
        items,
        next: more && items.length > 0 ? items[items.length - 1].ts : null,
        prev: null,
        available: true,
    };
}

// status and duration live in the request entries' data
function matchesMetrics(entry: RuntimeEntry, query: RuntimeQuery): boolean {
    const { status, min_ms: min, max_ms: max } = query;
    if (status === undefined && min === undefined && max === undefined) {
        return true;
    }
    if (status !== undefined && Number(entry.data.status) !== status) {
        return false;
    }
    if (min === undefined && max === undefined) return true;
    const ms = Number(entry.data.total_ms);
    if (!Number.isFinite(ms)) return false;
    if (min !== undefined && ms < min) return false;
    if (max !== undefined && ms > max) return false;
    return true;
}

export function readRuntimeLogs(
    root: string,
    query: RuntimeQuery,
): RuntimePage {
    const sources = query.sources?.length
        ? query.sources
        : query.source
          ? [query.source]
          : (Object.keys(RUNTIME_SOURCES) as RuntimeSource[]);
    if (sources.length === 1) return readOne(root, sources[0], query);

    const limit = Math.min(
        Math.max(Math.trunc(query.limit ?? DEFAULT_LIMIT), 1),
        MAX_LIMIT,
    );
    const pages = sources.map((source) => readOne(root, source, query));
    const merged = pages
        .flatMap((page) => page.items)
        .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
    const available = pages.some((page) => page.available);

    if (query.after) {
        const items = merged.slice(-limit);
        const hasNewer =
            merged.length > limit || pages.some((page) => page.prev != null);
        return {
            items,
            next: null,
            prev: hasNewer && items.length > 0 ? items[0].ts : null,
            available,
        };
    }

    const items = merged.slice(0, limit);
    const more =
        merged.length > limit || pages.some((page) => page.next !== null);
    return {
        items,
        next: more && items.length > 0 ? items[items.length - 1].ts : null,
        prev: null,
        available,
    };
}
@Injectable()
export class RuntimeLogsService {
    read(query: RuntimeQuery): RuntimePage {
        const root = runtimeLogRoot();
        if (!root) return { items: [], next: null, available: false };
        return readRuntimeLogs(root, query);
    }

    sources() {
        return Object.keys(RUNTIME_SOURCES);
    }
}
