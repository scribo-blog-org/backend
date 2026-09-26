/** Visible @nick in plain text or HTML (nick 3–24 chars). */
const MENTION_IN_TEXT = /@[a-zA-Z0-9_]{3,24}/g;
const LEGACY_MENTION = /@\[user:[a-f0-9]{24}\]/gi;

export function mentionTextSource(text: string) {
    return String(text || '')
        .replace(LEGACY_MENTION, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ');
}

export function extractMentionNicks(text: string) {
    const plain = mentionTextSource(text);
    const seen = new Set<string>();
    const nicks: string[] = [];

    MENTION_IN_TEXT.lastIndex = 0;
    let match = MENTION_IN_TEXT.exec(plain);
    while (match) {
        const nick = match[0].slice(1);
        const key = nick.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            nicks.push(nick);
        }
        match = MENTION_IN_TEXT.exec(plain);
    }

    return nicks;
}

export function newMentionNicks(previousText: string, nextText: string) {
    const previous = new Set(
        extractMentionNicks(previousText).map((nick) => nick.toLowerCase()),
    );
    return extractMentionNicks(nextText).filter(
        (nick) => !previous.has(nick.toLowerCase()),
    );
}
