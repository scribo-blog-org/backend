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

type Call = { at: number; op: string; collection: string; filter?: unknown };

const started = new WeakMap<object, Call>();

function describe(target: any): Omit<Call, 'at'> {
    if (typeof target.getFilter === 'function') {
        return {
            op: String(target.op ?? 'query'),
            collection: String(target.model?.collection?.name ?? ''),
            filter: filterShape(target.getFilter()),
        };
    }
    if (typeof target.pipeline === 'function') {
        return {
            op: 'aggregate',
            collection: String(target._model?.collection?.name ?? ''),
            filter: target
                .pipeline()
                .map((stage: object) => Object.keys(stage)[0]),
        };
    }
    return {
        op: 'save',
        collection: String(target.constructor?.collection?.name ?? ''),
    };
}

function begin(this: object) {
    started.set(this, { at: performance.now(), ...describe(this) });
}

function finish(this: object) {
    const call = started.get(this);
    if (!call) return;
    started.delete(this);
    const ended = performance.now();
    addDbQuery(call.at, ended);
    const ms = ended - call.at;
    if (ms >= SLOW_QUERY_MS) {
        reportSlow?.({
            collection: call.collection,
            op: call.op,
            ms,
            filter: call.filter,
        });
    }
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
    const ms = ended - call.at;
    if (ms >= SLOW_QUERY_MS) {
        reportSlow?.({
            collection: String(
                (this as { collection?: { name?: string } }).collection?.name ??
                    '',
            ),
            op: call.op,
            ms,
            filter: undefined,
        });
    }
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
