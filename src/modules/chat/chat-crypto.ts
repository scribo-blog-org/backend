import {
    createCipheriv,
    createDecipheriv,
    createHash,
    randomBytes,
} from 'crypto';

const PREFIX = 'enc:v1:';
const KEY_ID = /^[A-Za-z0-9_-]+$/;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class ChatCrypto {
    private readonly keys = new Map<string, Buffer>();

    /**
     * `keys` is a comma-separated list of `id:secret` pairs, `activeId` picks
     * the one used for new writes. Older keys stay in the list until every
     * stored value has been re-encrypted with the active one.
     */
    constructor(
        keys: string,
        private readonly activeId: string,
    ) {
        for (const entry of keys.split(',')) {
            const trimmed = entry.trim();
            if (!trimmed) continue;
            const separator = trimmed.indexOf(':');
            const id = trimmed.slice(0, separator);
            const secret = trimmed.slice(separator + 1);
            if (separator < 1 || !KEY_ID.test(id) || !secret) {
                throw new Error(
                    'CHAT_ENCRYPTION_KEYS must look like id:secret,id:secret',
                );
            }
            if (this.keys.has(id)) {
                throw new Error(`Duplicate chat encryption key id "${id}"`);
            }
            this.keys.set(id, createHash('sha256').update(secret).digest());
        }
        if (!this.keys.has(activeId)) {
            throw new Error(
                `CHAT_ENCRYPTION_ACTIVE_KEY "${activeId}" is not in CHAT_ENCRYPTION_KEYS`,
            );
        }
    }

    encrypt(text: string): string {
        const iv = randomBytes(IV_BYTES);
        const cipher = createCipheriv(
            'aes-256-gcm',
            this.keys.get(this.activeId)!,
            iv,
        );
        const body = Buffer.concat([
            cipher.update(text, 'utf8'),
            cipher.final(),
        ]);
        const payload = Buffer.concat([iv, cipher.getAuthTag(), body]);
        return `${PREFIX}${this.activeId}:${payload.toString('base64')}`;
    }

    decrypt(value: string): string {
        if (!value.startsWith(PREFIX)) {
            throw new Error('Stored chat text is not encrypted');
        }
        const [id, encoded] = value.slice(PREFIX.length).split(':');
        const key = this.keys.get(id);
        if (!key || !encoded) {
            throw new Error(`No chat encryption key "${id}"`);
        }
        const raw = Buffer.from(encoded, 'base64');
        const decipher = createDecipheriv(
            'aes-256-gcm',
            key,
            raw.subarray(0, IV_BYTES),
        );
        decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
        return Buffer.concat([
            decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
            decipher.final(),
        ]).toString('utf8');
    }
}
