import type { Schema } from 'mongoose';
import { addDbTime } from '../infra/request-context';

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

const started = new WeakMap<object, number>();

function begin(this: object) {
    started.set(this, performance.now());
}

function finish(this: object) {
    const at = started.get(this);
    if (at === undefined) return;
    started.delete(this);
    addDbTime(performance.now() - at);
}

export function dbTimingPlugin(schema: Schema) {
    schema.pre([...QUERY_OPS], begin);
    schema.post([...QUERY_OPS], finish);
    schema.pre('aggregate', begin);
    schema.post('aggregate', finish);
    schema.pre('save', begin);
    schema.post('save', finish);
}
