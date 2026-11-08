import { EventEmitter } from 'events';
import { watchSlowCommands } from './db-command-monitor';
import { onSlowQuery, type SlowQuery } from './db-timing.plugin';

type Command = Record<string, unknown>;

// A client that only emits the driver's command events.
function setup(threshold = 100) {
    const client = new EventEmitter();
    const slow: SlowQuery[] = [];
    onSlowQuery((query) => slow.push(query));
    watchSlowCommands(client as never, threshold);

    let nextId = 1;
    const run = (
        commandName: string,
        command: Command,
        duration: number,
        outcome: 'commandSucceeded' | 'commandFailed' = 'commandSucceeded',
    ) => {
        const requestId = nextId++;
        client.emit('commandStarted', { requestId, commandName, command });
        client.emit(outcome, { requestId, commandName, duration });
    };

    return { run, slow };
}

afterEach(() => onSlowQuery(undefined));

describe('watchSlowCommands', () => {
    it('ignores a command that was fast', () => {
        const { run, slow } = setup();
        run('find', { find: 'posts', filter: { _id: 'x' } }, 3);
        run('find', { find: 'posts', filter: {} }, 99.9);
        expect(slow).toEqual([]);
    });

    it('reports a slow command with its collection, operation and filter shape', () => {
        const { run, slow } = setup();
        run(
            'find',
            { find: 'posts', filter: { author: 'u1', views: { $gt: 4 } } },
            140,
        );

        expect(slow).toHaveLength(1);
        expect(slow[0]).toMatchObject({
            collection: 'posts',
            op: 'find',
            ms: 140,
            filter: { author: '?', views: { $gt: '?' } },
        });
    });

    it('describes an aggregation by the names of its stages', () => {
        const { run, slow } = setup();
        run(
            'aggregate',
            {
                aggregate: 'logs',
                pipeline: [{ $match: { a: 1 } }, { $group: { _id: '$x' } }],
            },
            220,
        );
        expect(slow[0].filter).toEqual(['$match', '$group']);
    });

    it('reads the collection of a getMore from its own field', () => {
        const { run, slow } = setup();
        run('getMore', { getMore: 7n, collection: 'users' }, 180);
        expect(slow[0]).toMatchObject({ collection: 'users', op: 'getMore' });
    });

    it('does not count commands that are not queries of the app', () => {
        const { run, slow } = setup();
        run('hello', { hello: 1 }, 500);
        run('ping', { ping: 1 }, 500);
        run('saslStart', { saslStart: 1 }, 500);
        run('createIndexes', { createIndexes: 'posts' }, 900);
        run('listCollections', { listCollections: 1 }, 900);
        expect(slow).toEqual([]);
    });

    it('does not report writes to the log on the log', () => {
        const { run, slow } = setup();
        run('insert', { insert: 'logs', documents: [{}] }, 400);
        run('insert', { insert: 'posts', documents: [{}] }, 400);
        expect(slow.map((query) => query.collection)).toEqual(['posts']);
    });

    it('also reports a slow command that failed', () => {
        const { run, slow } = setup();
        run('find', { find: 'users', filter: {} }, 250, 'commandFailed');
        expect(slow).toHaveLength(1);
    });

    it('respects the threshold it is given', () => {
        const { run, slow } = setup(500);
        run('find', { find: 'posts', filter: {} }, 300);
        run('find', { find: 'posts', filter: {} }, 600);
        expect(slow).toHaveLength(1);
        expect(slow[0].ms).toBe(600);
    });

    it('keeps overlapping commands apart', () => {
        const client = new EventEmitter();
        const slow: SlowQuery[] = [];
        onSlowQuery((query) => slow.push(query));
        watchSlowCommands(client as never, 100);

        client.emit('commandStarted', {
            requestId: 1,
            commandName: 'find',
            command: { find: 'posts', filter: {} },
        });
        client.emit('commandStarted', {
            requestId: 2,
            commandName: 'find',
            command: { find: 'users', filter: {} },
        });
        client.emit('commandSucceeded', { requestId: 2, duration: 2 });
        client.emit('commandSucceeded', { requestId: 1, duration: 150 });

        expect(slow).toHaveLength(1);
        expect(slow[0].collection).toBe('posts');
    });
});
