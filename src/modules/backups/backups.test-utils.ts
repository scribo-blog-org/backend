import { Types } from 'mongoose';

export type Doc = Record<string, any>;

function matches(doc: Doc, filter: Doc) {
    return Object.entries(filter).every(([key, want]) => {
        if (want && typeof want === 'object' && '$ne' in want) {
            return doc[key] !== want.$ne;
        }
        return (doc[key] ?? null) === want;
    });
}

class Query {
    private order: ((a: Doc, b: Doc) => number) | null = null;
    private from = 0;
    private max = Infinity;

    constructor(
        private readonly docs: Doc[],
        private readonly filter: Doc,
    ) {}

    select() {
        return this;
    }
    sort() {
        this.order = (a, b) => b.started_at.getTime() - a.started_at.getTime();
        return this;
    }
    skip(n: number) {
        this.from = n;
        return this;
    }
    limit(n: number) {
        this.max = n;
        return this;
    }
    lean() {
        const list = this.docs.filter((d) => matches(d, this.filter));
        if (this.order) list.sort(this.order);
        return Promise.resolve(list.slice(this.from, this.from + this.max));
    }
}

/** Минимальная замена mongoose-модели в памяти: ровно то, что трогает код бекапов. */
export function fakeModel() {
    const docs: Doc[] = [];
    return {
        docs,
        countDocuments: jest.fn(() => Promise.resolve(docs.length)),
        updateMany: jest.fn((filter: Doc, patch: Doc) => {
            docs.filter((d) => matches(d, filter)).forEach((d) =>
                Object.assign(d, patch),
            );
            return Promise.resolve({});
        }),
        create: jest.fn((data: Doc) => {
            const doc = { _id: new Types.ObjectId().toString(), ...data };
            docs.push(doc);
            return Promise.resolve({ ...doc, toObject: () => doc });
        }),
        updateOne: jest.fn((filter: Doc, patch: Doc) => {
            Object.assign(docs.find((d) => matches(d, filter)) ?? {}, patch);
            return Promise.resolve({});
        }),
        find: jest.fn((filter: Doc = {}) => new Query(docs, filter)),
        findById: jest.fn((id: string) => {
            const doc = docs.find((d) => d._id === id) ?? null;
            return {
                lean: () => Promise.resolve(doc),
                then: (resolve: (v: Doc | null) => unknown) => resolve(doc),
            };
        }),
    };
}

export function fakeConnection(collections: string[] = ['users', 'posts']) {
    const names = [...collections];
    return {
        names,
        name: 'scribo',
        db: {
            listCollections: () => ({
                toArray: () => Promise.resolve(names.map((name) => ({ name }))),
            }),
            dropCollection: jest.fn((name: string) => {
                names.splice(names.indexOf(name), 1);
                return Promise.resolve(true);
            }),
        },
    };
}
