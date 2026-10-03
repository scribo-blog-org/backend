import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'path';
import { fieldError } from '../http/http-errors';
import { UPLOADS_URL_PATH, uploadsPublicUrl } from './files.config';
import { FilesDisk } from './files.disk';
import { ALLOWED_IMAGE_MIME_TYPES, UPLOAD_LIMIT_SIZE } from './upload';

export type ImageKind = 'avatar' | 'featured_image';
export type ImageField = 'userAvatar' | 'featuredImage';

@Injectable()
export class FilesService {
    private readonly publicUrl: string;

    constructor(
        config: ConfigService,
        private readonly disk: FilesDisk,
    ) {
        this.publicUrl = uploadsPublicUrl(config);
    }

    async assertReady() {
        await this.disk.ensureReady();
        return { dir: this.disk.root, publicUrl: this.publicUrl };
    }

    async saveImage(
        file: Express.Multer.File | undefined,
        kind: ImageKind,
        name: string,
        field: ImageField,
    ): Promise<string | null> {
        if (!file) return null;

        if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
            throw fieldError(
                field,
                'Incorrect file type, only images (jpeg, png, gif, webp) are allowed!',
                file.mimetype,
            );
        }
        if (file.size > UPLOAD_LIMIT_SIZE) {
            throw fieldError(
                field,
                `Max size of image should be ${UPLOAD_LIMIT_SIZE / 1024 / 1024} MB!`,
                file.size,
            );
        }

        const key = `src/${kind}/${name}${path.extname(file.originalname).toLowerCase()}`;
        try {
            await this.disk.write(key, file.buffer);
        } catch {
            throw new InternalServerErrorException(
                'Error to upload image to storage!',
            );
        }
        return `${UPLOADS_URL_PATH}/${key}`;
    }

    async remove(url?: string | null): Promise<boolean> {
        const key = uploadKey(url);
        if (!key) return false;
        try {
            await this.disk.remove(key);
            return true;
        } catch {
            return false;
        }
    }
}

function uploadKey(url?: string | null): string | null {
    if (!url) return null;
    let pathname: string;
    if (url.startsWith('/')) {
        try {
            pathname = new URL(url, 'http://localhost').pathname;
        } catch {
            return null;
        }
    } else {
        try {
            const parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
                return null;
            }
            pathname = parsed.pathname;
        } catch {
            return null;
        }
    }
    const prefix = `${UPLOADS_URL_PATH}/`;
    if (!pathname.startsWith(prefix)) return null;
    let key: string;
    try {
        key = decodeURIComponent(pathname.slice(prefix.length));
    } catch {
        return null;
    }
    if (!key || key.split('/').some((part) => part === '..' || part === '')) {
        return null;
    }
    return key;
}
