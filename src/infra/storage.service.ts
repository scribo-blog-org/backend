import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import AWS from 'aws-sdk';
import path from 'path';
import { fieldError } from '../http/http-errors';
import { ALLOWED_IMAGE_MIME_TYPES, UPLOAD_LIMIT_SIZE } from './upload';

process.env.AWS_SDK_JS_SUPPRESS_MAINTENANCE_MODE_MESSAGE = '1';

@Injectable()
export class StorageService {
    private readonly s3: AWS.S3;

    constructor(private readonly config: ConfigService) {
        AWS.config.update({
            accessKeyId: this.config.get<string>('AWS_CONNECT_ACCESS_KEY'),
            secretAccessKey: this.config.get<string>(
                'AWS_CONNECT_SECRET_ACCESS_KEY',
            ),
            region: this.config.get<string>('AWS_CONNECT_REGION'),
            maxRetries: 0,
            httpOptions: { timeout: 8000, connectTimeout: 5000 },
        });
        this.s3 = new AWS.S3({ maxRetries: 0 });
    }

    async assertReady() {
        const bucket = this.config
            .get<string>('AWS_CONNECT_BUCKET_NAME')
            ?.trim();
        const region = this.config.get<string>('AWS_CONNECT_REGION')?.trim();
        if (!bucket || !region) {
            throw new Error(
                'AWS setup failed: AWS_CONNECT_BUCKET_NAME and AWS_CONNECT_REGION are required',
            );
        }

        await this.s3.headBucket({ Bucket: bucket }).promise();
        return { bucket, region };
    }

    async uploadImage(
        file: Express.Multer.File | undefined,
        type: 'avatar' | 'featured_image',
        fileName: string,
        field: 'userAvatar' | 'featuredImage',
    ) {
        if (!file) {
            return null;
        }

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

        const fileExtension = path.extname(file.originalname).toLowerCase();
        const key = `src/${type}/${fileName}${fileExtension}`;
        const bucket = this.config.getOrThrow<string>(
            'AWS_CONNECT_BUCKET_NAME',
        );
        const region = this.config.getOrThrow<string>('AWS_CONNECT_REGION');

        try {
            const result = await this.s3
                .putObject({
                    Bucket: bucket,
                    Key: key,
                    Body: file.buffer,
                    ContentType: file.mimetype,
                })
                .promise();

            if (!result.ETag) {
                throw new InternalServerErrorException(
                    'Error to upload image to storage!',
                );
            }

            return `https://${bucket}.s3.${region}.amazonaws.com/${key}`;
        } catch (error) {
            if (error instanceof InternalServerErrorException) {
                throw error;
            }
            throw new InternalServerErrorException(
                'Error to upload image to storage!',
            );
        }
    }

    async deleteFile(fileUrl?: string | null) {
        if (!fileUrl) {
            return false;
        }

        try {
            const parsed = new URL(fileUrl);
            const key = decodeURIComponent(parsed.pathname).slice(1);
            await this.s3
                .deleteObject({
                    Bucket: this.config.getOrThrow<string>(
                        'AWS_CONNECT_BUCKET_NAME',
                    ),
                    Key: key,
                })
                .promise();
            return true;
        } catch {
            return false;
        }
    }
}
