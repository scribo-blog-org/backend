import {
    hasMediaMarkup,
    htmlToText,
    ownMediaUrls,
    postExcerpt,
    sanitizePostHtml,
} from './post-html';

const own = (url: string) =>
    url.startsWith('/uploads/src/post_media/') ? url : null;
const clean = (html: string) => sanitizePostHtml(html, own);

describe('sanitizePostHtml', () => {
    it('keeps the allowed formatting', () => {
        const html =
            '<p>Hi <strong>a</strong> <em>b</em> <u>c</u> <s>d</s></p><ul><li>x</li></ul><ol><li>y</li></ol><blockquote>q</blockquote><h2>t</h2><h3>t</h3><hr>';
        expect(clean(html)).toBe(
            '<p>Hi <strong>a</strong> <em>b</em> <u>c</u> <s>d</s></p><ul><li>x</li></ul><ol><li>y</li></ol><blockquote>q</blockquote><h2>t</h2><h3>t</h3><hr />',
        );
    });

    it('removes scripts, styles, handlers and unknown tags', () => {
        const out = clean(
            '<p onclick="x()">a<script>alert(1)</script><style>p{}</style><iframe src="https://e.com"></iframe><b style="color:red">b</b></p>',
        );
        expect(out).toBe('<p>a<b>b</b></p>');
    });

    it('keeps mention and hashtag spans but drops other classes', () => {
        expect(
            clean(
                '<span class="mention">@a</span><span class="hashtag evil">#b</span><span class="x">c</span>',
            ),
        ).toBe(
            '<span class="mention">@a</span><span class="hashtag">#b</span><span>c</span>',
        );
    });

    it('allows only http, https and mailto links and adds rel', () => {
        const out = clean(
            '<a href="https://a.com">a</a><a href="mailto:x@y.z">m</a><a href="/users/me">r</a><a href="javascript:alert(1)">j</a><a href="data:text/html,x">d</a>',
        );
        expect(out).toContain(
            '<a href="https://a.com" rel="noopener noreferrer">a</a>',
        );
        expect(out).toContain('href="mailto:x@y.z"');
        expect(out).toContain('href="/users/me"');
        expect(out).not.toContain('javascript:');
        expect(out).not.toContain('data:');
    });

    it('keeps code blocks with language classes only', () => {
        expect(
            clean(
                '<pre><code class="language-ts evil">const a = 1 &lt; 2;</code></pre>',
            ),
        ).toBe(
            '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
        );
    });

    it('keeps own media and strips foreign or empty media', () => {
        const out = clean(
            '<figure class="post_media" data-media-type="image" data-media-id="1" onclick="x"><img src="/uploads/src/post_media/a.png" alt="a" onerror="x()"></figure>' +
                '<img src="https://evil.com/t.png">' +
                '<img>' +
                '<video src="/uploads/src/post_media/v.mp4" poster="https://evil.com/p.png" controls muted playsinline loop></video>' +
                '<video src="http://evil.com/v.mp4"></video>',
        );
        expect(out).toContain(
            '<figure class="post_media" data-media-type="image" data-media-id="1"><img src="/uploads/src/post_media/a.png" alt="a" /></figure>',
        );
        expect(out).not.toContain('evil.com');
        expect(out).toContain('<video src="/uploads/src/post_media/v.mp4"');
        expect(out).toContain('controls');
        expect(out).not.toContain('<img />');
        expect((out.match(/<video/g) ?? []).length).toBe(1);
    });

    it('rejects javascript in media sources', () => {
        expect(clean('<img src="javascript:alert(1)">')).toBe('');
    });
});

describe('text helpers', () => {
    it('strips markup into plain text', () => {
        expect(htmlToText('<p>a &amp; b</p><p>c<br>d</p>')).toBe('a & b c d');
    });

    it('builds an ~80 char excerpt', () => {
        const text = 'word '.repeat(40);
        const excerpt = postExcerpt(`<p>${text}</p>`);
        expect(excerpt.length).toBeLessThanOrEqual(80);
        expect(excerpt.endsWith('…')).toBe(true);
        expect(postExcerpt('<p>short</p>')).toBe('short');
        expect(postExcerpt(undefined)).toBe('');
    });

    it('finds media markup and own urls', () => {
        expect(hasMediaMarkup('<p>x</p>')).toBe(false);
        expect(hasMediaMarkup('<p><img src="/a"></p>')).toBe(true);
        expect(
            ownMediaUrls(
                '<img src="/uploads/src/post_media/a.png"><video src="/uploads/src/post_media/b.mp4" poster="/uploads/src/post_media/c.jpg">',
            ),
        ).toEqual([
            '/uploads/src/post_media/a.png',
            '/uploads/src/post_media/b.mp4',
            '/uploads/src/post_media/c.jpg',
        ]);
    });
});
