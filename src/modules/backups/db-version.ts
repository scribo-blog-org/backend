import type { Connection } from 'mongoose';

export const META_COLLECTION = 'app_meta';
const META_ID = 'db';

export type DbMeta = {
    version: string | null;
    app_version: string;
    synced_at: Date;
};

export function dbVersionOf(
    appVersion: string | null | undefined,
): string | null {
    const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(appVersion ?? '');
    return match ? `${Number(match[1])}.${Number(match[2])}` : null;
}

export function incompatibility(
    archive: string | null | undefined,
    current: string | null,
): string | null {
    if (!current) {
        return 'The backend version is unknown, backups cannot be checked';
    }
    if (archive !== current) {
        return `The backup has data version ${archive ?? 'unknown'}, this system works with ${current}`;
    }
    return null;
}

export async function readDbMeta(
    connection: Pick<Connection, 'db'>,
): Promise<DbMeta | null> {
    const doc = await connection.db
        ?.collection<{ _id: string } & DbMeta>(META_COLLECTION)
        .findOne({ _id: META_ID });
    return doc
        ? {
              version: doc.version ?? null,
              app_version: doc.app_version,
              synced_at: doc.synced_at,
          }
        : null;
}

export async function syncDbMeta(
    connection: Pick<Connection, 'db'>,
    appVersion: string,
): Promise<{ previous: DbMeta | null; current: DbMeta }> {
    const previous = await readDbMeta(connection);
    const current: DbMeta = {
        version: dbVersionOf(appVersion),
        app_version: appVersion,
        synced_at: new Date(),
    };
    await connection.db
        ?.collection<{ _id: string } & DbMeta>(META_COLLECTION)
        .updateOne(
            { _id: META_ID },
            { $set: current, $setOnInsert: { created_at: new Date() } as any },
            { upsert: true },
        );
    return { previous, current };
}
