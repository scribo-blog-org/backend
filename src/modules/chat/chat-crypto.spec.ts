import { ChatCrypto } from './chat-crypto';

describe('ChatCrypto', () => {
    const crypto = new ChatCrypto('k1:test-secret', 'k1');

    it('round-trips text and tags it with the key id', () => {
        const encrypted = crypto.encrypt('Привет, 👋');
        expect(encrypted.startsWith('enc:v1:k1:')).toBe(true);
        expect(encrypted).not.toContain('Привет');
        expect(crypto.decrypt(encrypted)).toBe('Привет, 👋');
    });

    it('uses a fresh iv for every call', () => {
        expect(crypto.encrypt('same')).not.toBe(crypto.encrypt('same'));
    });

    it('refuses values that are not encrypted', () => {
        expect(() => crypto.decrypt('old message')).toThrow();
        expect(() => crypto.decrypt('')).toThrow();
    });

    it('refuses a value encrypted with a different secret', () => {
        const encrypted = crypto.encrypt('secret');
        expect(() =>
            new ChatCrypto('k1:other', 'k1').decrypt(encrypted),
        ).toThrow();
    });

    it('reads old keys and writes with the active one', () => {
        const before = new ChatCrypto('k1:one', 'k1').encrypt('hello');
        const rotated = new ChatCrypto('k1:one,k2:two', 'k2');
        expect(rotated.decrypt(before)).toBe('hello');
        expect(rotated.isActive(before)).toBe(false);
        const after = rotated.encrypt('hello');
        expect(ChatCrypto.keyIdOf(after)).toBe('k2');
        expect(rotated.isActive(after)).toBe(true);
    });

    it('fails when the key of a value was removed', () => {
        const before = new ChatCrypto('k1:one', 'k1').encrypt('hello');
        expect(() => new ChatCrypto('k2:two', 'k2').decrypt(before)).toThrow(
            'No chat encryption key "k1"',
        );
    });

    it.each([
        ['', 'k1'],
        ['secret', 'k1'],
        ['k1:a,k1:b', 'k1'],
        ['k1:a', 'k2'],
        ['bad id:a', 'bad id'],
    ])('rejects invalid config %j / %j', (keys, active) => {
        expect(() => new ChatCrypto(keys, active)).toThrow();
    });
});
