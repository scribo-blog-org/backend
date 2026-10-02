import type { ConfigService } from '@nestjs/config';
import path from 'path';

type Env = Pick<ConfigService, 'get'>;

/** Путь, под которым nginx (в dev — сам backend) отдаёт каталог загрузок. */
export const UPLOADS_URL_PATH = '/uploads';

export function uploadsDir(config: Env): string {
    const dir = config.get<string>('UPLOADS_DIR')?.trim();
    return path.resolve(dir || path.join(process.cwd(), 'uploads'));
}

/**
 * Адрес каталога загрузок снаружи, без слэша в конце. В базе хранится
 * `<база>/<ключ>`, поэтому смена домена требует миграции ссылок.
 */
export function uploadsPublicUrl(config: Env): string {
    const explicit = config.get<string>('UPLOADS_PUBLIC_URL')?.trim();
    if (explicit) return explicit.replace(/\/+$/, '');
    const origin = config.get<string>('API_ORIGIN')?.trim();
    const port = config.get<string>('PORT') ?? '3001';
    return `${(origin || `http://localhost:${port}`).replace(/\/+$/, '')}${UPLOADS_URL_PATH}`;
}

/** В проде файлы отдаёт nginx напрямую с тома, Node их не читает. */
export function backendServesUploads(env: NodeJS.ProcessEnv): boolean {
    if (env.SERVE_UPLOADS) return env.SERVE_UPLOADS === 'true';
    return env.NODE_ENV !== 'production';
}
