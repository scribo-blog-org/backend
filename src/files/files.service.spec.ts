import { ConfigService } from '@nestjs/config';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { FilesDisk } from './files.disk';
import { FilesService } from './files.service';

describe('FilesService', () => {
    let dir: string;
    let files: FilesService;

    const image = (name = 'a.PNG', mimetype = 'image/png') =>
        ({
            originalname: name,
            mimetype,
            size: 3,
            buffer: Buffer.from('abc'),
        }) as Express.Multer.File;

    beforeEach(async () => {
        dir = mkdtempSync(path.join(tmpdir(), 'scribo-files-'));
        const config = new ConfigService({
            UPLOADS_DIR: dir,
            API_ORIGIN: 'https://example.test/',
        });
        files = new FilesService(config, new FilesDisk(config));
        await files.assertReady();
    });

    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('saves an image and returns its public url', async () => {
        const url = await files.saveImage(
            image(),
            'avatar',
            'u1',
            'userAvatar',
        );

        expect(url).toBe('/uploads/src/avatar/u1.png');
        const target = path.join(dir, 'src/avatar/u1.png');
        expect(existsSync(target)).toBe(true);
        expect(statSync(target).mode & 0o777).toBe(0o644);
    });

    it('rejects non-image files', async () => {
        await expect(
            files.saveImage(
                image('a.txt', 'text/plain'),
                'avatar',
                'u1',
                'userAvatar',
            ),
        ).rejects.toBeDefined();
    });

    it('removes a saved file by url', async () => {
        const url = await files.saveImage(
            image(),
            'avatar',
            'u1',
            'userAvatar',
        );

        expect(await files.remove(url)).toBe(true);
        expect(existsSync(path.join(dir, 'src/avatar/u1.png'))).toBe(false);
    });

    it('removes a file stored under an older absolute url', async () => {
        await files.saveImage(image(), 'avatar', 'u1', 'userAvatar');

        expect(
            await files.remove('https://old.example/uploads/src/avatar/u1.png'),
        ).toBe(true);
        expect(existsSync(path.join(dir, 'src/avatar/u1.png'))).toBe(false);
    });

    it('ignores foreign urls and path traversal', async () => {
        expect(await files.remove('https://b.s3.amazonaws.com/src/a.jpg')).toBe(
            false,
        );
        expect(await files.remove('/uploads/../../etc/passwd')).toBe(false);
        expect(
            await files.remove('https://example.test/uploads/../../etc/passwd'),
        ).toBe(false);
        expect(await files.remove(null)).toBe(false);
    });
});
