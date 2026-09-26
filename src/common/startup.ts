import { ConfigService } from '@nestjs/config';

const REQUIRED_ENV = [
    'JWTKEY',
    'AWS_CONNECT_ACCESS_KEY',
    'AWS_CONNECT_SECRET_ACCESS_KEY',
    'AWS_CONNECT_REGION',
    'AWS_CONNECT_BUCKET_NAME',
] as const;

export function assertSetup(env: NodeJS.ProcessEnv) {
    const missing: string[] = REQUIRED_ENV.filter((key) => !env[key]?.trim());
    if (!mongoConfigured(env)) {
        missing.push('MONGODB_URI or DB_USER, DB_PASSWORD and DB_NAME');
    }
    if (missing.length) {
        throw new Error(`Setup failed, missing: ${missing.join(', ')}`);
    }
}

export function mongoUri(config: ConfigService) {
    const uri = config.get<string>('MONGODB_URI')?.trim();
    if (uri) return uri;

    const user = config.get<string>('DB_USER')?.trim();
    const password = config.get<string>('DB_PASSWORD')?.trim();
    const dbName = config.get<string>('DB_NAME')?.trim();
    if (!user || !password || !dbName) {
        throw new Error('Set MONGODB_URI or DB_USER, DB_PASSWORD and DB_NAME');
    }

    const userPart = encodeURIComponent(user);
    const passwordPart = encodeURIComponent(password);
    const dbPart = encodeURIComponent(dbName);
    return `mongodb+srv://${userPart}:${passwordPart}@cluster0.lccalb5.mongodb.net/${dbPart}?retryWrites=true&w=majority`;
}

function mongoConfigured(env: NodeJS.ProcessEnv) {
    if (env.MONGODB_URI?.trim()) return true;
    return Boolean(
        env.DB_USER?.trim() && env.DB_PASSWORD?.trim() && env.DB_NAME?.trim(),
    );
}
