import { BadRequestException, Injectable } from '@nestjs/common';
import { assertPublicUrl } from './ssrf';

export type PreviewResult = {
    url: string;
    title: string;
    description: string;
    image: string | null;
    site_name: string | null;
    media_type?: 'image' | 'gif' | 'video' | null;
};

const MAX_REDIRECTS = 4;
const MAX_BYTES = 250_000;

@Injectable()
export class LinkPreviewService {
    private readMeta(html: string, property: string) {
        const patterns = [
            new RegExp(
                `<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']+)["']`,
                'i',
            ),
            new RegExp(
                `<meta[^>]+content=["']([^"']+)["'][^>]+property=["']${property}["']`,
                'i',
            ),
            new RegExp(
                `<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']+)["']`,
                'i',
            ),
        ];

        for (const pattern of patterns) {
            const match = html.match(pattern);
            if (match?.[1]) {
                return match[1].trim();
            }
        }

        return '';
    }

    private resolveUrl(base: string, value: string | null | undefined) {
        if (!value) {
            return null;
        }

        try {
            const resolved = new URL(value, base);
            if (!['http:', 'https:'].includes(resolved.protocol)) {
                return null;
            }
            return resolved.href;
        } catch {
            return null;
        }
    }

    private async readCapped(response: Response): Promise<string> {
        if (!response.body) return '';
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        try {
            while (total < MAX_BYTES) {
                const { done, value } = await reader.read();
                if (done || !value) break;
                chunks.push(value);
                total += value.byteLength;
            }
        } finally {
            await reader.cancel().catch(() => undefined);
        }
        return Buffer.concat(chunks).toString('utf8').slice(0, MAX_BYTES);
    }

    private async fetchSafe(start: URL): Promise<Response | null> {
        let current = start;
        for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
            try {
                await assertPublicUrl(current);
            } catch {
                throw new BadRequestException('Invalid URL');
            }
            let response: Response;
            try {
                response = await fetch(current.href, {
                    headers: {
                        'User-Agent':
                            'Mozilla/5.0 (compatible; ScriboBot/1.0; +https://scribo-blog.vercel.app)',
                        Accept: 'text/html,application/xhtml+xml,image/*,video/*;q=0.8',
                    },
                    signal: AbortSignal.timeout(8000),
                    redirect: 'manual',
                });
            } catch {
                return null;
            }
            if (response.status >= 300 && response.status < 400) {
                const location = response.headers.get('location');
                await response.body?.cancel().catch(() => undefined);
                if (!location) return null;
                try {
                    current = new URL(location, current);
                } catch {
                    return null;
                }
                continue;
            }
            return response;
        }
        return null;
    }

    async fetchPreview(rawUrl: string): Promise<PreviewResult> {
        let parsed: URL;

        try {
            parsed = new URL(rawUrl);
        } catch {
            throw new BadRequestException('Invalid URL');
        }

        if (!['http:', 'https:'].includes(parsed.protocol)) {
            throw new BadRequestException('Invalid URL');
        }

        const fallback: PreviewResult = {
            url: parsed.href,
            title: parsed.hostname,
            description: '',
            image: null,
            site_name: parsed.hostname || null,
        };

        const response = await this.fetchSafe(parsed);
        if (!response || !response.ok) {
            return fallback;
        }

        const contentType = (response.headers.get('content-type') || '')
            .split(';')[0]
            .trim()
            .toLowerCase();
        if (
            contentType.startsWith('image/') ||
            contentType.startsWith('video/')
        ) {
            await response.body?.cancel().catch(() => undefined);
            const isVideo = contentType.startsWith('video/');
            return {
                ...fallback,
                image: isVideo ? null : parsed.href,
                media_type: isVideo
                    ? 'video'
                    : contentType === 'image/gif'
                      ? 'gif'
                      : 'image',
            };
        }

        const html = await this.readCapped(response);
        const title =
            this.readMeta(html, 'og:title') ||
            this.readMeta(html, 'twitter:title') ||
            html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.trim() ||
            parsed.hostname;
        const description =
            this.readMeta(html, 'og:description') ||
            this.readMeta(html, 'twitter:description') ||
            this.readMeta(html, 'description') ||
            '';
        const image = this.resolveUrl(
            parsed.href,
            this.readMeta(html, 'og:image') ||
                this.readMeta(html, 'twitter:image'),
        );
        const siteName =
            this.readMeta(html, 'og:site_name') || parsed.hostname || null;

        return {
            url: parsed.href,
            title,
            description,
            image,
            site_name: siteName,
        };
    }
}
