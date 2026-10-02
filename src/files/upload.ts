import { FileInterceptor } from '@nestjs/platform-express';
import { fieldError } from '../http/http-errors';

export const UPLOAD_LIMIT_SIZE = 5 * 1024 * 1024;

export const ALLOWED_IMAGE_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/jpg',
];

export function imageFileInterceptor(field: 'userAvatar' | 'featuredImage') {
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
