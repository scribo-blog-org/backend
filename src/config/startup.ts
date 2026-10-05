import { ConfigService } from '@nestjs/config';
import { ChatCrypto } from '../modules/chat/chat-crypto';
import { assertKeyPair } from './jwt-keys';

const REQUIRED_ENV = [
    'JWT_PRIVATE_KEY',
    'JWT_PUBLIC_KEY',
    'REDIS_URL',
    'CHAT_ENCRYPTION_KEYS',
    'CHAT_ENCRYPTION_ACTIVE_KEY',
] as const;

export function assertSetup(env: NodeJS.ProcessEnv) {
    const missing: string[] = REQUIRED_ENV.filter((key) => !env[key]?.trim());
    if (!mongoConfigured(env)) {
        missing.push(
            'MONGODB_URI or DB_USER, DB_PASSWORD, DB_HOST and DB_NAME',
        );
    }
    if (missing.length) {
        throw new Error(`Setup failed, missing: ${missing.join(', ')}`);
    }
    assertKeyPair(env.JWT_PRIVATE_KEY!.trim(), env.JWT_PUBLIC_KEY!.trim());
    new ChatCrypto(
        env.CHAT_ENCRYPTION_KEYS!.trim(),
        env.CHAT_ENCRYPTION_ACTIVE_KEY!.trim(),
    );
}

export function mongoUri(config: ConfigService) {
    const uri = config.get<string>('MONGODB_URI')?.trim();
    if (uri) return uri;

    const user = config.get<string>('DB_USER')?.trim();
    const password = config.get<string>('DB_PASSWORD')?.trim();
    const host = dbHost(config.get<string>('DB_HOST'));
    const dbName = config.get<string>('DB_NAME')?.trim();
    if (!user || !password || !host || !dbName) {
        throw new Error(
            'Set MONGODB_URI or DB_USER, DB_PASSWORD, DB_HOST and DB_NAME',
        );
    }

    const userPart = encodeURIComponent(user);
    const passwordPart = encodeURIComponent(password);
    const dbPart = encodeURIComponent(dbName);
    return `mongodb+srv://${userPart}:${passwordPart}@${host}/${dbPart}?retryWrites=true&w=majority`;
}

function dbHost(value: string | undefined): string {
    const raw = value?.trim() ?? '';
    if (!raw) return '';
    const withoutScheme = raw.replace(/^mongodb(?:\+srv)?:\/\//, '');
    return withoutScheme.split('/')[0].split('?')[0];
}

function mongoConfigured(env: NodeJS.ProcessEnv) {
    if (env.MONGODB_URI?.trim()) return true;
    return Boolean(
        env.DB_USER?.trim() &&
        env.DB_PASSWORD?.trim() &&
        env.DB_HOST?.trim() &&
        env.DB_NAME?.trim(),
    );
}
