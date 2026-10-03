import {
    BadRequestException,
    ConflictException,
    HttpException,
    Injectable,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { rm } from 'fs/promises';
import path from 'path';
import { ArchiveError, checkMongoDump, verifyArchive } from './archive';
import { redact } from './backups.config';
import { BackupsService } from './backups.service';
import { MONGO_ARCHIVE } from './manifest';

const MAX_ENTRIES = 500_000;
const UNPACK_RATIO = 4;

@Injectable()
export class BackupImportService {
    constructor(private readonly archives: BackupsService) {}

    async importFile(input: {
        tempPath: string;
        originalName: string;
        size: number;
        userId?: string;
    }) {
        const cfg = this.archives.settings;
        if (!cfg.restoreEnabled) {
            throw new ConflictException('Restore is disabled');
        }
        if (!this.archives.acquire('backup')) {
            throw new ConflictException(
                'A backup or a restore is already running',
            );
        }
        const work = this.archives.pathOf(
            `.work-${randomBytes(6).toString('hex')}`,
        );
        try {
            const manifest = await verifyArchive({
                tar: cfg.tar,
                file: input.tempPath,
                work,
                dbVersion: this.archives.currentDbVersion(),
                limits: {
                    maxEntries: MAX_ENTRIES,
                    maxBytes: input.size * UNPACK_RATIO,
                },
            });
            await checkMongoDump(path.join(work, MONGO_ARCHIVE));
            const listed = await this.archives.listedArchive(manifest.id);
            if (listed) return { record: listed, duplicate: true };
            const record = await this.archives.adopt(input.tempPath, manifest, {
                userId: input.userId,
                originalName: input.originalName,
            });
            return { record, duplicate: false };
        } catch (error) {
            if (error instanceof HttpException) throw error;
            const message = redact(
                error instanceof Error ? error.message : String(error),
            );
            throw new BadRequestException(
                error instanceof ArchiveError
                    ? message
                    : `The archive could not be read: ${message}`,
            );
        } finally {
            await rm(work, { recursive: true, force: true });
            this.archives.release();
        }
    }
}
