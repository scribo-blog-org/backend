import type { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { mkdir } from 'fs/promises';
import { diskStorage } from 'multer';
import { backupsConfig } from './backups.config';

/**
 * Загруженный архив пишется на диск прямо в каталог бекапов под именем
 * .upload-*.partial: большой файл не должен сидеть в памяти, а остатки после
 * падения убирает removeLeftovers при старте.
 */
export function backupUploadOptions(config: Pick<ConfigService, 'get'>) {
    const cfg = backupsConfig(config);
    return {
        storage: diskStorage({
            destination: (_req, _file, done) => {
                mkdir(cfg.dir, { recursive: true, mode: 0o700 })
                    .then(() => done(null, cfg.dir))
                    .catch((error) => done(error, cfg.dir));
            },
            filename: (_req, _file, done) =>
                done(null, `.upload-${randomBytes(8).toString('hex')}.partial`),
        }),
        limits: { fileSize: cfg.uploadMaxBytes, files: 1 },
    };
}
