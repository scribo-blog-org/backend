import { detectMime, mimeMatches } from './magic';
import {
    ALLOWED_POST_MEDIA_MIME_TYPES,
    POST_MEDIA_TYPE_ERROR,
    UPLOAD_LIMIT_SIZE,
    postMediaFileFilter,
    postMediaKind,
    postMediaLimitSize,
} from './upload';

describe('post media upload rules', () => {
    it('keeps the avatar limit at 5 MB and post media at 100 MB', () => {
        expect(UPLOAD_LIMIT_SIZE).toBe(5 * 1024 * 1024);
        expect(postMediaLimitSize()).toBe(100 * 1024 * 1024);
    });

    it('accepts the documented image, gif and video types', () => {
        expect([...ALLOWED_POST_MEDIA_MIME_TYPES].sort()).toEqual(
            [
                'image/avif',
                'image/gif',
                'image/jpeg',
                'image/png',
                'image/webp',
                'video/mp4',
                'video/quicktime',
                'video/webm',
            ].sort(),
        );
        expect(postMediaKind('image/gif')).toBe('gif');
        expect(postMediaKind('image/avif')).toBe('image');
        expect(postMediaKind('video/quicktime')).toBe('video');
        expect(postMediaKind('application/pdf')).toBeNull();
    });

    it('filters by mime type', () => {
        const accept = jest.fn();
        postMediaFileFilter(null, { mimetype: 'video/mp4' }, accept);
        expect(accept).toHaveBeenCalledWith(null, true);

        const reject = jest.fn();
        postMediaFileFilter(null, { mimetype: 'image/svg+xml' }, reject);
        expect(reject).toHaveBeenCalledTimes(1);
        const [error, ok] = reject.mock.calls[0];
        expect(ok).toBe(false);
        expect(error.getResponse()).toMatchObject({
            message: POST_MEDIA_TYPE_ERROR,
            field: 'file',
        });
    });
});

describe('file signatures', () => {
    const buf = (bytes: number[]) => Buffer.from(bytes);

    it('detects the supported formats', () => {
        expect(detectMime(buf([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
        expect(
            detectMime(buf([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
        ).toBe('image/png');
        expect(detectMime(Buffer.from('GIF89a....'))).toBe('image/gif');
        expect(detectMime(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe(
            'image/webp',
        );
        expect(detectMime(buf([0x1a, 0x45, 0xdf, 0xa3, 0]))).toBe('video/webm');
        expect(detectMime(Buffer.from('\0\0\0\x18ftypmp42'))).toBe('video/mp4');
        expect(detectMime(Buffer.from('\0\0\0\x18ftypqt  '))).toBe(
            'video/quicktime',
        );
        expect(detectMime(Buffer.from('\0\0\0\x18ftypavif'))).toBe(
            'image/avif',
        );
        expect(detectMime(Buffer.from('<svg xmlns='))).toBeNull();
    });

    it('matches declared and detected types', () => {
        expect(mimeMatches('image/png', 'image/png')).toBe(true);
        expect(mimeMatches('video/mp4', 'video/quicktime')).toBe(true);
        expect(mimeMatches('image/png', 'image/jpeg')).toBe(false);
        expect(mimeMatches('image/png', null)).toBe(false);
    });
});
