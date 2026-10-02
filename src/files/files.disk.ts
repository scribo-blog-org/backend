import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { access, chmod, constants, mkdir, rm, writeFile } from 'fs/promises';
import path from 'path';
import { uploadsDir } from './files.config';

/**
 * Нижний слой: только байты и пути на диске. Ничего не знает ни про
 * валидацию, ни про ссылки. Каталоги 755 и файлы 644, чтобы nginx под другим
 * пользователем мог читать том.
 */
@Injectable()
export class FilesDisk {
    readonly root: string;

    constructor(config: ConfigService) {
        this.root = uploadsDir(config);
    }

    async ensureReady() {
        await mkdir(this.root, { recursive: true, mode: 0o755 });
        await access(this.root, constants.R_OK | constants.W_OK);
    }

    async write(key: string, data: Buffer) {
        const target = this.resolve(key);
        await mkdir(path.dirname(target), { recursive: true, mode: 0o755 });
        await writeFile(target, data, { mode: 0o644 });
        await chmod(target, 0o644);
    }

    async remove(key: string) {
        await rm(this.resolve(key), { force: true });
    }

    private resolve(key: string): string {
        const target = path.resolve(this.root, key);
        if (!target.startsWith(this.root + path.sep)) {
            throw new Error(`File key escapes uploads dir: ${key}`);
        }
        return target;
    }
}
