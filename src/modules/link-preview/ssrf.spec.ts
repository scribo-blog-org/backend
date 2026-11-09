import { assertPublicUrl, isPrivateIp } from './ssrf';

describe('ssrf guard', () => {
    it('flags private, loopback and link-local addresses', () => {
        for (const ip of [
            '127.0.0.1',
            '10.1.2.3',
            '172.16.0.1',
            '192.168.1.1',
            '169.254.169.254',
            '100.64.0.1',
            '0.0.0.0',
            '::1',
            'fd00::1',
            'fe80::1',
            '::ffff:127.0.0.1',
            '::ffff:7f00:1',
        ]) {
            expect(isPrivateIp(ip)).toBe(true);
        }
        expect(isPrivateIp('8.8.8.8')).toBe(false);
        expect(isPrivateIp('2606:4700:4700::1111')).toBe(false);
    });

    it('rejects hosts that resolve to private addresses', async () => {
        await expect(
            assertPublicUrl(new URL('http://evil.example/'), async () => [
                '93.184.216.34',
                '10.0.0.5',
            ]),
        ).rejects.toThrow();
    });

    it('rejects localhost, credentials, odd ports and other protocols', async () => {
        const ok = async () => ['93.184.216.34'];
        await expect(
            assertPublicUrl(new URL('http://localhost/'), ok),
        ).rejects.toThrow();
        await expect(
            assertPublicUrl(new URL('http://a.localhost/'), ok),
        ).rejects.toThrow();
        await expect(
            assertPublicUrl(new URL('http://u:p@example.com/'), ok),
        ).rejects.toThrow();
        await expect(
            assertPublicUrl(new URL('http://example.com:6379/'), ok),
        ).rejects.toThrow();
        await expect(
            assertPublicUrl(new URL('http://169.254.169.254/'), ok),
        ).rejects.toThrow();
        await expect(
            assertPublicUrl(new URL('ftp://example.com/'), ok),
        ).rejects.toThrow();
    });

    it('allows public hosts on default ports', async () => {
        await expect(
            assertPublicUrl(new URL('https://example.com/a'), async () => [
                '93.184.216.34',
            ]),
        ).resolves.toBeUndefined();
    });
});
