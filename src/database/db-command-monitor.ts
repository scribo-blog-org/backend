import type { mongo } from 'mongoose';
import { SLOW_QUERY_MS, emitSlowQuery, filterShape } from './db-timing.plugin';

type Doc = Record<string, unknown>;

type Started = { name: string; collection: string; command: Doc };

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
    const value = command[name];
    return typeof value === 'string' ? value : null;
}

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
            filter: shapeOf(started.name, started.command),
        });
    };

    client.on('commandSucceeded', finish);
    client.on('commandFailed', finish);
}
