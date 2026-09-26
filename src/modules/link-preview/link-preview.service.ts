import { BadRequestException, Injectable } from '@nestjs/common';

type PreviewResult = {
    url: string;
    title: string;
    description: string;
    image: string | null;
    site_name: string | null;
};

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
            return new URL(value, base).href;
        } catch {
            return null;
        }
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

        let response: Response;
        try {
            response = await fetch(parsed.href, {
                headers: {
                    'User-Agent':
                        'Mozilla/5.0 (compatible; ScriboBot/1.0; +https://scribo-blog.vercel.app)',
                    Accept: 'text/html,application/xhtml+xml',
                },
                signal: AbortSignal.timeout(8000),
                redirect: 'follow',
            });
        } catch {
            return fallback;
        }

        if (!response.ok) {
            return fallback;
        }

        const html = (await response.text()).slice(0, 250_000);
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
