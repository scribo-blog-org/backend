import {
    Controller,
    INestApplication,
    Post,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FileInterceptor, MulterModule } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import request from 'supertest';
import { backupUploadOptions } from './backups.upload';

@Controller('up')
class UploadProbe {
    @Post()
    @UseInterceptors(FileInterceptor('file'))
    take(@UploadedFile() file: Express.Multer.File) {
        return { path: file.path, size: file.size };
    }
}

describe('backup upload storage', () => {
    let root: string;
    let app: INestApplication;

    const boot = async (env: Record<string, string>) => {
        const config = new ConfigService({ BACKUPS_DIR: root, ...env });
        const module = await Test.createTestingModule({
            imports: [
                MulterModule.registerAsync({
                    useFactory: () => backupUploadOptions(config),
                }),
            ],
            controllers: [UploadProbe],
        }).compile();
        app = module.createNestApplication();
        await app.init();
    };

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), 'scribo-multer-'));
    });
    afterEach(async () => {
        await app?.close();
        rmSync(root, { recursive: true, force: true });
    });

    it('streams the file to a hidden .partial file in the backups directory', async () => {
        await boot({});
        const res = await request(app.getHttpServer())
            .post('/up')
            .attach('file', Buffer.from('archive-bytes'), 'b.tar')
            .expect(201);

        expect(path.dirname(res.body.path)).toBe(root);
        expect(path.basename(res.body.path)).toMatch(
            /^\.upload-[a-f0-9]+\.partial$/,
        );
        expect(readFileSync(res.body.path, 'utf8')).toBe('archive-bytes');
    });

    it('refuses a file over the size limit and removes what was written', async () => {
        await boot({ BACKUP_UPLOAD_MAX_MB: '1' });
        await request(app.getHttpServer())
            .post('/up')
            .attach('file', Buffer.alloc(2 * 1024 * 1024), 'big.tar')
            .expect(413);
        expect(readdirSync(root)).toEqual([]);
    });
});
