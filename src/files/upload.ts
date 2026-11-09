import { AnyFilesInterceptor, FileInterceptor } from '@nestjs/platform-express';
import { randomBytes } from 'crypto';
import { mkdirSync } from 'fs';
import { diskStorage } from 'multer';
import path from 'path';
import { fieldError } from '../http/http-errors';
import { uploadsDir } from './files.config';

export const UPLOAD_LIMIT_SIZE = 5 * 1024 * 1024;
export const POST_MEDIA_LIMIT_SIZE = 100 * 1024 * 1024;
export const POST_MEDIA_DIR = 'src/post_media';
export const POST_MEDIA_MAX_FILES = 10;
export const POST_MEDIA_BODY_OVERHEAD = 2 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/jpg',
];

export const POST_MEDIA_IMAGE_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/avif',
];
export const POST_MEDIA_GIF_MIME_TYPES = ['image/gif'];
export const POST_MEDIA_VIDEO_MIME_TYPES = [
    'video/mp4',
    'video/webm',
    'video/quicktime',
];
export const ALLOWED_POST_MEDIA_MIME_TYPES = [
    ...POST_MEDIA_IMAGE_MIME_TYPES,
    ...POST_MEDIA_GIF_MIME_TYPES,
    ...POST_MEDIA_VIDEO_MIME_TYPES,
];

export type PostMediaKind = 'image' | 'gif' | 'video';

export const POST_MEDIA_EXTENSIONS: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/avif': '.avif',
    'image/gif': '.gif',
    'video/mp4': '.mp4',
    'video/webm': '.webm',
    'video/quicktime': '.mov',
};

export const POST_MEDIA_TYPE_ERROR =
    'Incorrect file type, only images (jpeg, png, webp, avif), gif and videos (mp4, webm, mov) are allowed!';

export function postMediaKind(mime: string): PostMediaKind | null {
    if (POST_MEDIA_IMAGE_MIME_TYPES.includes(mime)) return 'image';
    if (POST_MEDIA_GIF_MIME_TYPES.includes(mime)) return 'gif';
    if (POST_MEDIA_VIDEO_MIME_TYPES.includes(mime)) return 'video';
    return null;
}

export function postMediaFileFilter(
    _req: unknown,
    file: { mimetype: string },
    callback: (error: Error | null, accept: boolean) => void,
) {
    if (!ALLOWED_POST_MEDIA_MIME_TYPES.includes(file.mimetype)) {
        callback(
            fieldError('file', POST_MEDIA_TYPE_ERROR, file.mimetype),
            false,
        );
        return;
    }
    callback(null, true);
}

export function imageFileInterceptor(field: 'userAvatar' | 'groupPhoto') {
    return FileInterceptor(field, {
        limits: { fileSize: UPLOAD_LIMIT_SIZE },
        fileFilter: (_req, file, callback) => {
            if (!ALLOWED_IMAGE_MIME_TYPES.includes(file.mimetype)) {
                callback(
                    fieldError(
                        field,
                        'Incorrect file type, only images (jpeg, png, gif, webp) are allowed!',
                        file.mimetype,
                    ),
                    false,
                );
                return;
            }
            callback(null, true);
        },
    });
}

export function postMediaFilesInterceptor() {
    const destination = path.join(
        uploadsDir({ get: (key: string) => process.env[key] }),
        POST_MEDIA_DIR,
    );
    return AnyFilesInterceptor({
        limits: {
            fileSize: POST_MEDIA_LIMIT_SIZE,
            files: POST_MEDIA_MAX_FILES,
        },
        storage: diskStorage({
            destination: (_req, _file, callback) => {
                try {
                    mkdirSync(destination, { recursive: true, mode: 0o755 });
                    callback(null, destination);
                } catch (error) {
                    callback(error as Error, destination);
                }
            },
            filename: (_req, file, callback) => {
                const ext = POST_MEDIA_EXTENSIONS[file.mimetype] ?? '';
                callback(
                    null,
                    `${Date.now()}-${randomBytes(8).toString('hex')}${ext}`,
                );
            },
        }),
        fileFilter: postMediaFileFilter,
    });
}
