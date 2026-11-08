import type { Schema } from 'mongoose';
import { addDbQuery } from '../infra/request-context';

const QUERY_OPS = [
    'find',
    'findOne',
    'findOneAndUpdate',
    'findOneAndDelete',
    'findOneAndReplace',
    'updateOne',
    'updateMany',
    'replaceOne',
    'deleteOne',
    'deleteMany',
    'countDocuments',
    'estimatedDocumentCount',
    'distinct',
] as const;

const SHAPE_DEPTH = 3;

export type SlowQuery = {
    collection: string;
    op: string;
    ms: number;
    filter: unknown;
};

export const SLOW_QUERY_MS = Number(process.env.SLOW_QUERY_MS) || 100;

let reportSlow: ((query: SlowQuery) => void) | undefined;

export function onSlowQuery(handler: ((query: SlowQuery) => void) | undefined) {
    reportSlow = handler;
}

// Slow queries are detected from the driver's command timing (see
// db-command-monitor.ts), which is the database's own time. The timing of the
// Mongoose calls below also counts the wait for a connection and for a busy
// event loop, so it is only used for the per-request share of database time.
export function emitSlowQuery(query: SlowQuery) {
    reportSlow?.(query);
}

// Keeps the keys and operators of a filter but drops every value, so a slow
// query can be identified without storing user data.
export function filterShape(value: unknown, depth = 0): unknown {
    if (Array.isArray(value)) {
        return depth >= SHAPE_DEPTH
            ? '[…]'
            : value.slice(0, 3).map((item) => filterShape(item, depth + 1));
    }
    if (
        value &&
        typeof value === 'object' &&
        Object.getPrototypeOf(value) === Object.prototype
    ) {
        if (depth >= SHAPE_DEPTH) return '{…}';
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                filterShape(item, depth + 1),
            ]),
        );
    }
    return '?';
}

type Call = { at: number };

const started = new WeakMap<object, Call>();

function begin(this: object) {
    started.set(this, { at: performance.now() });
}

function finish(this: object) {
    const call = started.get(this);
    if (!call) return;
    started.delete(this);
    const ended = performance.now();
    addDbQuery(call.at, ended);
}

type Bulk = { at: number; op: string };

const bulkStack = new WeakMap<object, Bulk[]>();

// bulkWrite and insertMany run on the model, so concurrent calls share `this`.
// The stack keeps their start times apart within one model.
function beginBulk(op: string) {
    return function (this: object) {
        const stack = bulkStack.get(this) ?? [];
        stack.push({ at: performance.now(), op });
        bulkStack.set(this, stack);
    };
}

function finishBulk(this: object) {
    const call = bulkStack.get(this)?.pop();
    if (!call) return;
    const ended = performance.now();
    addDbQuery(call.at, ended);
}

export function dbTimingPlugin(schema: Schema) {
    schema.pre([...QUERY_OPS], begin);
    schema.post([...QUERY_OPS], finish);
    schema.pre('aggregate', begin);
    schema.post('aggregate', finish);
    schema.pre('save', begin);
    schema.post('save', finish);
    schema.pre('insertMany', beginBulk('insertMany'));
    schema.post('insertMany', finishBulk);
    schema.pre('bulkWrite', beginBulk('bulkWrite'));
    schema.post('bulkWrite', finishBulk);
}
