import { execFileSync } from 'child_process';

export type BuildInfo = { sha: string | null; sha_short: string | null };

let cached: BuildInfo | undefined;

export function buildInfo(env: NodeJS.ProcessEnv = process.env): BuildInfo {
    if (cached) return cached;
    let sha: string | null = env.GIT_SHA?.trim() || null;
    if (!sha) {
        try {
            sha = execFileSync('git', ['rev-parse', 'HEAD'], {
                stdio: ['ignore', 'pipe', 'ignore'],
                timeout: 2000,
            })
                .toString()
                .trim();
        } catch {
            sha = null;
        }
    }
    cached = { sha, sha_short: sha ? sha.slice(0, 7) : null };
    return cached;
}
