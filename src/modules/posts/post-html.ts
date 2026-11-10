import sanitizeHtml from 'sanitize-html';

export type MediaUrlResolver = (url: string) => string | null;

const ALLOWED_TAGS = [
    'p',
    'br',
    'strong',
    'b',
    'em',
    'i',
    'u',
    's',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'h2',
    'h3',
    'hr',
    'pre',
    'code',
    'span',
    'figure',
    'figcaption',
    'img',
    'video',
];

export function sanitizePostHtml(
    html: string,
    ownMedia: MediaUrlResolver,
): string {
    return sanitizeHtml(html, {
        allowedTags: ALLOWED_TAGS,
        allowedAttributes: {
            a: ['href', 'rel', 'class', 'data-user-id'],
            span: ['class', 'data-user-id'],
            code: ['class'],
            pre: ['class'],
            figure: ['class', 'data-media-type', 'data-media-id'],
            img: ['src', 'alt', 'width', 'height', 'loading'],
            video: [
                'src',
                'poster',
                'controls',
                'loop',
                'muted',
                'playsinline',
                'preload',
                'width',
                'height',
            ],
        },
        allowedClasses: {
            a: ['mention', 'hashtag'],
            span: ['mention', 'hashtag'],
            code: ['language-*'],
            pre: ['language-*'],
            figure: ['post_media', 'post_media_*'],
        },
        allowedSchemes: ['http', 'https', 'mailto'],
        allowedSchemesByTag: {},
        allowProtocolRelative: false,
        disallowedTagsMode: 'discard',
        transformTags: {
            a: (tagName, attribs) => ({
                tagName,
                attribs: { ...attribs, rel: 'noopener noreferrer' },
            }),
            img: (tagName, attribs) => {
                const next = { ...attribs };
                const src = ownMedia(attribs.src ?? '');
                if (src) next.src = src;
                else delete next.src;
                return { tagName, attribs: next };
            },
            video: (tagName, attribs) => {
                const next = { ...attribs };
                const src = ownMedia(attribs.src ?? '');
                if (src) next.src = src;
                else delete next.src;
                if (attribs.poster) {
                    const poster = ownMedia(attribs.poster);
                    if (poster) next.poster = poster;
                    else delete next.poster;
                }
                return { tagName, attribs: next };
            },
        },
        exclusiveFilter: (frame) =>
            (frame.tag === 'img' || frame.tag === 'video') &&
            !frame.attribs.src,
    });
}

export function htmlToText(html: string | null | undefined): string {
    if (!html) return '';
    const spaced = String(html).replace(
        /<\/(?:p|div|li|h[1-6]|blockquote|pre|figure)>|<br\s*\/?>/gi,
        (match) => ` `,
    );
    return sanitizeHtml(spaced, {
        allowedTags: [],
        allowedAttributes: {},
    })
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();
}

export function postExcerpt(
    content: string | null | undefined,
    max = 80,
): string {
    const text = htmlToText(content);
    if (text.length <= max) return text;
    return `${text.slice(0, max - 1).trimEnd()}…`;
}

export function hasMediaMarkup(html: string): boolean {
    return /<(img|video)\b/i.test(html);
}

export function ownMediaUrls(html: string | null | undefined): string[] {
    if (!html) return [];
    const urls = new Set<string>();
    const pattern = /\b(?:src|poster)="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(String(html)))) {
        urls.add(match[1].replace(/&amp;/g, '&'));
    }
    return [...urls];
}
