import { spawn } from 'child_process';
import { createWriteStream } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const STDERR_TAIL = 1500;
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

export type RunOptions = {
    out?: string;
    accepted?: (code: number | null, stderr: string) => boolean;
    timeoutMs?: number;
};

export async function runProcess(
    command: string,
    args: string[],
    options: RunOptions = {},
): Promise<void> {
    const child = spawn(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let tail = '';
    child.stderr.on('data', (chunk: Buffer) => {
        tail = (tail + chunk.toString()).slice(-STDERR_TAIL);
    });
    const killer = setTimeout(
        () => child.kill('SIGKILL'),
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    const accepted = options.accepted ?? ((code) => code === 0);
    const name = path.basename(command);
    const exited = new Promise<void>((resolve, reject) => {
        child.on('error', (error: NodeJS.ErrnoException) =>
            reject(
                error.code === 'ENOENT'
                    ? new Error(`${name} is not installed`)
                    : error,
            ),
        );
        child.on('close', (code, signal) =>
            accepted(code, tail)
                ? resolve()
                : reject(
                      new Error(
                          `${name} exited with ${signal ?? `code ${code}`}: ${tail.trim()}`,
                      ),
                  ),
        );
    });
    try {
        await Promise.all([
            options.out
                ? pipeline(
                      child.stdout,
                      createWriteStream(options.out, { mode: 0o600 }),
                  )
                : pipeline(child.stdout, devNull()),
            exited,
        ]);
    } finally {
        clearTimeout(killer);
    }
}

function devNull() {
    return createWriteStream('/dev/null');
}
