import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { rm } from 'fs/promises';
import path from 'path';
import { fieldError } from '../http/http-errors';
import { UPLOADS_URL_PATH, uploadsPublicUrl } from './files.config';
import { FilesDisk } from './files.disk';
import { detectMime, mimeMatches, readHead } from './magic';
import {
    ALLOWED_IMAGE_MIME_TYPES,
    POST_MEDIA_DIR,
    postMediaFileSizeError,
    postMediaLimitSize,
    POST_MEDIA_TYPE_ERROR,
    UPLOAD_LIMIT_SIZE,
    postMediaKind,
    type PostMediaKind,
} from './upload';

export type ImageKind = 'avatar' | 'featured_image' | 'group';
export type ImageField = 'userAvatar' | 'featuredImage' | 'groupPhoto';

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

    async finalizePostMedia(file: Express.Multer.File | undefined): Promise<{
        type: PostMediaKind;
        url: string;
        mime: string;
        size: number;
    }> {
        if (!file) {
            throw fieldError('file', 'File is required!', null);
        }
        const discard = async () => {
            if (file.path) {
                await rm(file.path, { force: true }).catch(() => undefined);
            }
        };
        const kind = postMediaKind(file.mimetype);
        if (!kind) {
            await discard();
            throw fieldError('file', POST_MEDIA_TYPE_ERROR, file.mimetype);
        }
        if (file.size > postMediaLimitSize()) {
            await discard();
            throw fieldError('file', postMediaFileSizeError(), file.size);
        }
        if (!file.path || !file.filename) {
            throw new InternalServerErrorException(
                'Error to upload file to storage!',
            );
        }
        let detected: string | null;
        try {
            detected = detectMime(await readHead(file.path));
        } catch {
            await discard();
            throw new InternalServerErrorException(
                'Error to upload file to storage!',
            );
        }
        if (!mimeMatches(file.mimetype, detected)) {
            await discard();
            throw fieldError(
                'file',
                'File content does not match its type!',
                file.mimetype,
            );
        }
        return {
            type: kind,
            url: `${UPLOADS_URL_PATH}/${POST_MEDIA_DIR}/${file.filename}`,
            mime: file.mimetype,
            size: file.size,
        };
    }

    ownUploadPath(url: unknown, prefixes: string[]): string | null {
        if (typeof url !== 'string' || !url.trim()) return null;
        let value = url.trim();
        if (value.startsWith(`${this.publicUrl}/`)) {
            value = `${UPLOADS_URL_PATH}/${value.slice(this.publicUrl.length + 1)}`;
        }
        if (!value.startsWith('/')) return null;
        const key = uploadKey(value);
        if (!key) return null;
        if (!prefixes.some((prefix) => key.startsWith(`${prefix}/`))) {
            return null;
        }
        return `${UPLOADS_URL_PATH}/${key}`;
    }
    async uploadSize(url: string): Promise<number | null> {
        const key = uploadKey(url);
        if (!key) return null;
        return this.disk.size(key);
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
