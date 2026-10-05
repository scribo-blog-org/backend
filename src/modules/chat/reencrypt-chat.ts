/**
 * Brings every stored chat text to the active key.
 *
 *   node dist/modules/chat/reencrypt-chat.js [--dry-run]
 *
 * Handles three kinds of values: plain text from before encryption existed,
 * text encrypted with an older key, and text already on the active key (left
 * alone). Safe to run again and while the app is up: each write only applies if
 * the value is still the one that was read.
 */
import { ConfigService } from '@nestjs/config';
import mongoose from 'mongoose';
import { mongoUri } from '../../config/startup';
import { ChatCrypto } from './chat-crypto';

const BATCH = 500;
const TARGETS = [
    { collection: 'chat_messages', field: 'text' },
    { collection: 'conversations', field: 'last_message_text' },
];

export type ReencryptStats = {
    collection: string;
    scanned: number;
    updated: number;
    skipped: number;
};

export async function reencrypt(
    db: mongoose.mongo.Db,
    crypto: ChatCrypto,
    dryRun: boolean,
): Promise<ReencryptStats[]> {
    const stats: ReencryptStats[] = [];
    for (const { collection, field } of TARGETS) {
        const stat = { collection, scanned: 0, updated: 0, skipped: 0 };
        stats.push(stat);
        const cursor = db
            .collection(collection)
            .find({ [field]: { $type: 'string', $ne: '' } })
            .project({ [field]: 1 })
            .batchSize(BATCH);

        let ops: mongoose.mongo.AnyBulkWriteOperation[] = [];
        const flush = async () => {
            if (!ops.length) return;
            if (!dryRun) {
                const result = await db.collection(collection).bulkWrite(ops);
                stat.skipped += ops.length - result.modifiedCount;
                stat.updated += result.modifiedCount;
            } else {
                stat.updated += ops.length;
            }
            ops = [];
        };

        for await (const doc of cursor) {
            stat.scanned++;
            const value = doc[field] as string;
            if (crypto.isActive(value)) continue;
            const plain = ChatCrypto.isEncrypted(value)
                ? crypto.decrypt(value)
                : value;
            ops.push({
                updateOne: {
                    filter: { _id: doc._id, [field]: value },
                    update: { $set: { [field]: crypto.encrypt(plain) } },
                },
            });
            if (ops.length >= BATCH) await flush();
        }
        await flush();
    }
    return stats;
}

async function main() {
    try {
        process.loadEnvFile('.env');
    } catch {
        // the environment may come from the container instead of a file
    }
    const dryRun = process.argv.includes('--dry-run');
    const crypto = new ChatCrypto(
        process.env.CHAT_ENCRYPTION_KEYS?.trim() ?? '',
        process.env.CHAT_ENCRYPTION_ACTIVE_KEY?.trim() ?? '',
    );

    await mongoose.connect(mongoUri(new ConfigService()));
    try {
        const stats = await reencrypt(mongoose.connection.db!, crypto, dryRun);
        console.log(dryRun ? 'Dry run, nothing written' : 'Done');
        console.table(stats);
    } finally {
        await mongoose.disconnect();
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
