import type { ConfigService } from '@nestjs/config';
import path from 'path';

type Env = Pick<ConfigService, 'get'>;

export const UPLOADS_URL_PATH = '/uploads';

export function uploadsDir(config: Env): string {
    const dir = config.get<string>('UPLOADS_DIR')?.trim();
    return path.resolve(dir || path.join(process.cwd(), 'uploads'));
}

export function uploadsPublicUrl(config: Env): string {
    const explicit = config.get<string>('UPLOADS_PUBLIC_URL')?.trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    const origin = config.get<string>('API_ORIGIN')?.trim();
    const port = config.get<string>('PORT') ?? '3001';
    return `${(origin || `http://localhost:${port}`).replace(/\/+$/, '')}${UPLOADS_URL_PATH}`;
}

export function backendServesUploads(env: NodeJS.ProcessEnv): boolean {
    if (env.SERVE_UPLOADS) return env.SERVE_UPLOADS === 'true';
    return env.NODE_ENV !== 'production';
}
