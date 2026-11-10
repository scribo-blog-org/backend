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
    source: RuntimeSource;
    level?: string;
    q?: string;
    from?: string;
    to?: string;
    before?: string;
    limit?: number;
};

export type RuntimePage = {
    items: RuntimeEntry[];
    next: string | null;
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

export function readRuntimeLogs(
    root: string,
    query: RuntimeQuery,
): RuntimePage {
    const config = RUNTIME_SOURCES[query.source];
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
    const items: RuntimeEntry[] = [];
    let more = false;

    for (const file of files) {
        if (from !== null && statSync(file).mtimeMs < from) break;
        const lines = readLines(file);
        for (let i = lines.length - 1; i >= 0; i -= 1) {
            const line = lines[i];
            if (needle && !line.toLowerCase().includes(needle)) continue;
            const entry = parseRuntimeLine(line, query.source);
            if (!entry) continue;
            const time = Date.parse(entry.ts);
            if (before !== null && time >= before) continue;
            if (to !== null && time > to) continue;
            if (from !== null && time < from) continue;
            if (levels && levels.size > 0 && !levels.has(entry.level)) continue;
            if (items.length >= limit) {
                more = true;
                break;
            }
            items.push(entry);
        }
        if (more) break;
    }
    return {
        items,
        next: more && items.length > 0 ? items[items.length - 1].ts : null,
        available: true,
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
