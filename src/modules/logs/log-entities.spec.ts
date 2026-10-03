import { entitiesPipeline, escapeRegex, toEntities } from './log-entities';
import { LogsQueryService } from './logs.service';

const collections = {
    users: 'users',
    posts: 'posts',
    categories: 'categories',
};

describe('escapeRegex', () => {
    it('makes user input a literal', () => {
        const rx = new RegExp(escapeRegex('a.b(c)[d]*'), 'i');
        expect(rx.test('A.B(C)[D]*')).toBe(true);
        expect(rx.test('aXb(c)[d]*')).toBe(false);
    });
});

describe('entitiesPipeline', () => {
    const stage = (pipeline: any[], key: string) =>
        pipeline.filter((s) => key in s);

    it('turns every log into the entities it is about, snapshots included', () => {
        const [project] = stage(
            entitiesPipeline({ regex: null, collections, skip: 0, limit: 5 }),
            '$project',
        );
        const names = project.$project.e.map((e: any) => `${e.type}:${e.name}`);
        expect(names).toEqual([
            'user:$data.user_nick',
            'user:$data.target_nick',
            'user:$data.target_nick',
            'post:$data.post_title',
            'category:$data.category_snapshot.name',
        ]);
    });

    it('without a search drops only nameless entities', () => {
        const pipeline = entitiesPipeline({
            regex: null,
            collections,
            skip: 0,
            limit: 5,
        });
        const last = stage(pipeline, '$match').at(-1) as any;
        expect(last.$match.name).toEqual({ $nin: [null, ''] });
    });

    it('with a search matches the current name, case-insensitively', () => {
        const regex = new RegExp(escapeRegex('upd'), 'i');
        const pipeline = entitiesPipeline({
            regex,
            collections,
            skip: 0,
            limit: 5,
        });
        const last = stage(pipeline, '$match').at(-1) as any;
        expect(last.$match.name.$regex).toBe(regex);
    });

    it('looks up live names in the given collections and paginates after filtering', () => {
        const pipeline = entitiesPipeline({
            regex: null,
            collections,
            skip: 40,
            limit: 20,
        });
        const from = stage(pipeline, '$lookup').map((s: any) => s.$lookup.from);
        expect(from).toEqual(['users', 'posts', 'categories']);
        const facet = stage(pipeline, '$facet')[0] as any;
        expect(facet.$facet.items.slice(0, 2)).toEqual([
            { $skip: 40 },
            { $limit: 20 },
        ]);
        expect(pipeline.indexOf(facet)).toBe(pipeline.length - 1);
    });
});

describe('toEntities', () => {
    it('maps group rows to the response shape', () => {
        const last = new Date();
        expect(
            toEntities([
                {
                    _id: { type: 'post', id: 'p1' },
                    name: 'Hello',
                    last,
                    count: 3,
                },
            ]),
        ).toEqual([{ type: 'post', id: 'p1', name: 'Hello', count: 3, last }]);
    });
});

describe('LogsQueryService.entities', () => {
    const model = (name: string, aggregate?: jest.Mock) =>
        ({ collection: { name }, aggregate }) as never;

    it('runs the pipeline with the search and returns a page', async () => {
        const aggregate = jest.fn().mockResolvedValue([
            {
                items: [
                    {
                        _id: { type: 'user', id: 'u1' },
                        name: 'Maks',
                        last: new Date(),
                        count: 5,
                    },
                ],
                total: [{ n: 41 }],
            },
        ]);
        const service = new LogsQueryService(
            model('logs', aggregate),
            model('users'),
            model('posts'),
            model('categories'),
        );

        const result = await service.entities(
            { search: '  ma(  ', page: 2, limit: 20 },
            { id: 'a', role: 'admin' } as never,
        );

        const pipeline = aggregate.mock.calls[0][0];
        const match = pipeline.filter((s: any) => '$match' in s).at(-1);
        expect(match.$match.name.$regex.test('Ma(')).toBe(true);
        expect(match.$match.name.$regex.test('Mx')).toBe(false);
        expect(
            pipeline.find((s: any) => '$facet' in s).$facet.items[0],
        ).toEqual({ $skip: 20 });
        expect(result.items).toHaveLength(1);
        expect(result.pagination).toMatchObject({
            page: 2,
            limit: 20,
            total: 41,
            pages: 3,
        });
    });

    it('refuses users without the permission', async () => {
        const service = new LogsQueryService(
            model('logs', jest.fn()),
            model('users'),
            model('posts'),
            model('categories'),
        );
        await expect(
            service.entities({}, { id: 'a', role: 'user' } as never),
        ).rejects.toThrow('permission');
    });
});
