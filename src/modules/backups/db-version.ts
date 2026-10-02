import type { Connection } from 'mongoose';

export const META_COLLECTION = 'app_meta';
const META_ID = 'db';

export type DbMeta = {
    /** Версия данных: мажор и минор версии backend, например `6.1`. */
    version: string | null;
    /** Полная версия backend, которая последней открывала эту базу. */
    app_version: string;
    synced_at: Date;
};

/**
 * Версия данных по версии backend: `6.1.2` даёт `6.1`. Исправления (третья
 * цифра) формат данных не меняют, а новая функция поднимает минор, и бекапы
 * старого минора перестают подходить. Поднимать версию отдельно руками не
 * нужно: она следует за `version` в package.json.
 */
export function dbVersionOf(
    appVersion: string | null | undefined,
): string | null {
    const match = /^(\d+)\.(\d+)(?:\.|$)/.exec(appVersion ?? '');
    return match ? `${Number(match[1])}.${Number(match[2])}` : null;
}

/** Почему архив нельзя ставить в эту систему, или null, если версии совпадают. */
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

/**
 * Записывает в саму базу, какой версией backend она сейчас обслуживается.
 * Зовётся при каждом запуске и после отката: восстановленная база приносит
 * свою запись, а работать с ней уже эта версия.
 */
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
