import { readFile, rename, rm, writeFile } from 'fs/promises';
import path from 'path';

export type CurrentBackup = {
    backup_id: string;
    file_name: string;
    day: string;
    taken_at: string;
    restored_at: string;
    restored_by: string | null;
};

export type RestoreOutcome = {
    backup_id: string;
    file_name: string;
    started_at: string;
    finished_at: string;
    restored_by: string | null;
    status: 'success' | 'failed' | 'interrupted';
    rolled_back: boolean;
    safety_backup_id: string | null;
    error: string | null;
};

export type BackupState = {
    current: CurrentBackup | null;
    last_restore: RestoreOutcome | null;
    history: RestoreOutcome[];
};

const EMPTY: BackupState = { current: null, last_restore: null, history: [] };
const HISTORY_LIMIT = 20;

export async function readState(dir: string): Promise<BackupState> {
    try {
        const raw = JSON.parse(
            await readFile(path.join(dir, 'state.json'), 'utf8'),
        ) as Partial<BackupState>;
        return {
            current: raw.current ?? null,
            last_restore: raw.last_restore ?? null,
            history: Array.isArray(raw.history) ? raw.history : [],
        };
    } catch {
        return { ...EMPTY, history: [] };
    }
}

export async function writeState(dir: string, state: BackupState) {
    const target = path.join(dir, 'state.json');
    const temp = `${target}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(temp, target);
}

export async function recordRestore(
    dir: string,
    outcome: RestoreOutcome,
    current?: CurrentBackup,
) {
    const state = await readState(dir);
    state.last_restore = outcome;
    state.history = [outcome, ...state.history].slice(0, HISTORY_LIMIT);
    if (current) state.current = current;
    await writeState(dir, state);
}

export type RestoreLock = {
    backup_id: string;
    file_name: string;
    started_at: string;
    restored_by: string | null;
    safety_backup_id: string | null;
};

const lockPath = (dir: string) => path.join(dir, 'restore.lock');

export async function writeLock(dir: string, lock: RestoreLock) {
    await writeFile(lockPath(dir), JSON.stringify(lock), { mode: 0o600 });
}

export async function readLock(dir: string): Promise<RestoreLock | null> {
    try {
        return JSON.parse(await readFile(lockPath(dir), 'utf8')) as RestoreLock;
    } catch {
        return null;
    }
}

export async function removeLock(dir: string) {
    await rm(lockPath(dir), { force: true });
}
