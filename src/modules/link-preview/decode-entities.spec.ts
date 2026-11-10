import { decodeHtmlEntities } from './link-preview.service';

describe('decodeHtmlEntities', () => {
    it('decodes named, decimal and hex entities', () => {
        expect(
            decodeHtmlEntities(
                'fleem_ff&#39;s clip &#34;x&#34; &amp; &quot;y&quot;',
            ),
        ).toBe('fleem_ff\'s clip "x" & "y"');
        expect(decodeHtmlEntities('&#x41;&#66;&lt;&gt;')).toBe('AB<>');
    });

    it('leaves unknown or invalid entities untouched', () => {
        expect(decodeHtmlEntities('&unknown; &#0; &#99999999;')).toBe(
            '&unknown; &#0; &#99999999;',
        );
    });
});
