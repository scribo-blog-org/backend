import type { mongo } from 'mongoose';
import { SLOW_QUERY_MS, emitSlowQuery, filterShape } from './db-timing.plugin';

// A query is slow when the database took long to run it, measured by the
// driver on the command itself: from the moment it is sent on a connection to
// the moment its reply arrives. That leaves out the time a query spends in our
// own process before it is sent (waiting for a free connection, or for a busy
// event loop). Timing the Mongoose call from the outside counted that time too,
// and a stalled Node process then looked like a slow database.

type Doc = Record<string, unknown>;

type Started = { name: string; collection: string; command: Doc };

// Housekeeping that is not a query of the app, and writes to the log itself,
// which would report on its own reporting.
const IGNORED_COMMANDS = new Set([
    'createIndexes',
    'listIndexes',
    'listCollections',
    'dropIndexes',
    'drop',
    'create',
    'collMod',
    'renameCollection',
]);
const LOG_COLLECTION = 'logs';

const MAX_PENDING = 5000;

function collectionOf(name: string, command: Doc): string | null {
    if (name === 'getMore') {
        return typeof command.collection === 'string'
            ? command.collection
            : null;
    }
    // Commands about a collection carry its name as their own value. Others
    // (hello, ping, saslStart) carry a number and are not queries.
    const value = command[name];
    return typeof value === 'string' ? value : null;
}

// Which documents a command was about, with the values removed.
function shapeOf(name: string, command: Doc): unknown {
    switch (name) {
        case 'find':
            return filterShape(command.filter);
        case 'aggregate':
            return Array.isArray(command.pipeline)
                ? command.pipeline.map((stage: object) => Object.keys(stage)[0])
                : undefined;
        case 'count':
        case 'distinct':
        case 'findAndModify':
            return filterShape(command.query);
        case 'update':
            return Array.isArray(command.updates)
                ? filterShape((command.updates[0] as Doc | undefined)?.q)
                : undefined;
        case 'delete':
            return Array.isArray(command.deletes)
                ? filterShape((command.deletes[0] as Doc | undefined)?.q)
                : undefined;
        default:
            return undefined;
    }
}

export function watchSlowCommands(
    client: Pick<mongo.MongoClient, 'on'>,
    thresholdMs: number = SLOW_QUERY_MS,
) {
    const pending = new Map<number, Started>();

    client.on('commandStarted', (event: mongo.CommandStartedEvent) => {
        const name = event.commandName;
        if (IGNORED_COMMANDS.has(name)) return;

        const collection = collectionOf(name, event.command as Doc);
        if (!collection) return;
        if (name === 'insert' && collection === LOG_COLLECTION) return;

        if (pending.size >= MAX_PENDING) pending.clear();
        pending.set(event.requestId, {
            name,
            collection,
            command: event.command as Doc,
        });
    });

    const finish = (
        event: mongo.CommandSucceededEvent | mongo.CommandFailedEvent,
    ) => {
        const started = pending.get(event.requestId);
        if (!started) return;
        pending.delete(event.requestId);

        if (event.duration < thresholdMs) return;
        emitSlowQuery({
            collection: started.collection,
            op: started.name,
            ms: event.duration,
            // Only built for a slow one; a fast command never pays for it.
            filter: shapeOf(started.name, started.command),
        });
    };

    client.on('commandSucceeded', finish);
    client.on('commandFailed', finish);
}
