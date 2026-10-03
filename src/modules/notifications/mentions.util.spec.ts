import {
    extractMentionNicks,
    mentionTextSource,
    newMentionNicks,
} from './mentions.util';

describe('mentions.util', () => {
    it('extracts nicks from plain text', () => {
        expect(extractMentionNicks('Hello @alice and @bob_12')).toEqual([
            'alice',
            'bob_12',
        ]);
    });

    it('extracts nicks from post html', () => {
        const html =
            '<p>Hi <span class="mention">@writer</span> check this</p>';
        expect(extractMentionNicks(html)).toEqual(['writer']);
    });

    it('ignores legacy id tokens', () => {
        expect(
            extractMentionNicks('@[user:507f1f77bcf86cd799439011] @real'),
        ).toEqual(['real']);
    });

    it('dedupes nicks case-insensitively', () => {
        expect(extractMentionNicks('@Alice @alice')).toEqual(['Alice']);
    });

    it('returns only newly added nicks on edit', () => {
        expect(newMentionNicks('@old one', '@old two @new_user')).toEqual([
            'new_user',
        ]);
    });

    it('strips html before matching', () => {
        expect(mentionTextSource('<a href="/x">@skip</a>@valid')).toContain(
            '@valid',
        );
    });
});
