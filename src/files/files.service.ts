import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import path from 'path';
import { fieldError } from '../http/http-errors';
import { uploadsPublicUrl } from './files.config';
import { FilesDisk } from './files.disk';
import { ALLOWED_IMAGE_MIME_TYPES, UPLOAD_LIMIT_SIZE } from './upload';

export type ImageKind = 'avatar' | 'featured_image';
export type ImageField = 'userAvatar' | 'featuredImage';

/**
 * Слой файлов для сервисов приложения, как репозиторий для базы: сервисы
 * зовут saveImage и remove и не знают, где и как лежат файлы.
 */
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

    /** Сохраняет картинку и возвращает её публичную ссылку. */
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
        return `${this.publicUrl}/${key}`;
    }

    /** Удаляет файл по ссылке. Чужие и старые (S3) ссылки игнорируются. */
    async remove(url?: string | null): Promise<boolean> {
        if (!url?.startsWith(`${this.publicUrl}/`)) return false;
        try {
            const key = decodeURIComponent(
                url.slice(this.publicUrl.length + 1),
            );
            await this.disk.remove(key);
            return true;
        } catch {
            return false;
        }
    }
}
