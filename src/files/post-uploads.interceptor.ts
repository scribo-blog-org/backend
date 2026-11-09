import {
    CallHandler,
    ExecutionContext,
    Injectable,
    NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import { rm } from 'fs/promises';
import { Observable, catchError, from, switchMap, throwError } from 'rxjs';
import { fieldError } from '../http/http-errors';
import { POST_MEDIA_BODY_OVERHEAD, POST_MEDIA_LIMIT_SIZE } from './upload';

export const POST_MEDIA_TOTAL_ERROR = 'Media in one post cannot exceed 100 MB';

type UploadRequest = Request & {
    files?: Express.Multer.File[] | Record<string, Express.Multer.File[]>;
    postUploadsOwned?: boolean;
};

export function uploadedFiles(req: UploadRequest): Express.Multer.File[] {
    const files = req.files;
    if (!files) return [];
    return Array.isArray(files) ? files : Object.values(files).flat();
}

export async function discardFiles(
    files: Array<Pick<Express.Multer.File, 'path'>> | undefined,
) {
    for (const file of files ?? []) {
        if (file?.path) {
            await rm(file.path, { force: true }).catch(() => undefined);
        }
    }
}

@Injectable()
export class PostUploadsGuardInterceptor implements NestInterceptor {
    intercept(context: ExecutionContext, next: CallHandler) {
        const req = context.switchToHttp().getRequest<UploadRequest>();
        const length = Number(req.headers['content-length']);
        if (
            Number.isFinite(length) &&
            length > POST_MEDIA_LIMIT_SIZE + POST_MEDIA_BODY_OVERHEAD
        ) {
            throw fieldError('media', POST_MEDIA_TOTAL_ERROR, length);
        }
        return next.handle();
    }
}

@Injectable()
export class PostUploadsCleanupInterceptor implements NestInterceptor {
    intercept(
        context: ExecutionContext,
        next: CallHandler,
    ): Observable<unknown> {
        const req = context.switchToHttp().getRequest<UploadRequest>();
        return next
            .handle()
            .pipe(
                catchError((error) =>
                    from(
                        req.postUploadsOwned
                            ? Promise.resolve()
                            : discardFiles(uploadedFiles(req)),
                    ).pipe(switchMap(() => throwError(() => error))),
                ),
            );
    }
}
