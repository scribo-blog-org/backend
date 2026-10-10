import { LogsQueryService, levelFilter, searchFilter } from './logs.service';

describe('LogsQueryService user filter', () => {
    const admin = { id: 'a', role: 'admin' } as never;

    it('matches what the user did and what was done to the user', async () => {
        const find = jest.fn().mockReturnValue({
            sort: () => ({
                skip: () => ({ limit: () => ({ lean: () => [] }) }),
            }),
        });
        const model = { find, countDocuments: jest.fn().mockResolvedValue(0) };
        const service = new LogsQueryService(
            model as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
        );

        await service.list({ user: 'plain-id' } as never, admin);

        const filter = find.mock.calls[0][0];
        expect(filter.$or.map((item: any) => Object.keys(item)[0])).toEqual([
            'data.user',
            'data.target_user',
            'data.updated_user',
        ]);
    });
});

describe('conversation filter', () => {
    it('matches single and bulk chat events together with the level', async () => {
        const find = jest.fn().mockReturnValue({
            sort: () => ({
                skip: () => ({ limit: () => ({ lean: () => [] }) }),
            }),
        });
        const model = { find, countDocuments: jest.fn().mockResolvedValue(0) };
        const service = new LogsQueryService(
            model as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
        );
        await service.list(
            { conversation: 'chat-1', level: 'error' } as never,
            { id: 'a', role: 'admin' } as never,
        );
        const filter = find.mock.calls[0][0];
        expect(filter.$and).toHaveLength(3);
        expect(JSON.stringify(filter.$and[0])).toContain('data.conversations');
    });
});

describe('levelFilter', () => {
    it('treats legacy error types without a level as errors', () => {
        const filter = levelFilter('error') as {
            $or: Array<Record<string, unknown>>;
        };
        expect(filter.$or).toContainEqual({ level: 'error' });
        expect(filter.$or).toContainEqual({
            level: { $exists: false },
            type: {
                $in: ['server_error', 'backup_failed', 'backup_upload_failed'],
            },
        });
    });

    it('excludes problems from info', () => {
        expect(levelFilter('info')).toHaveProperty('$nor');
        expect(levelFilter('warn')).toEqual({ level: 'warn' });
    });
});

describe('search', () => {
    it('matches a type typed with spaces and escapes regex characters', () => {
        const { $or } = searchFilter('slow request');
        const type = $or.find((item: any) => 'type' in item) as any;
        expect(type.type.test('slow_request')).toBe(true);
        expect(type.type.test('SLOW REQUEST')).toBe(true);

        const dots = searchFilter('a.b(c').$or.find(
            (item: any) => 'message' in item,
        ) as any;
        expect(dots.message.test('xa.b(cx')).toBe(true);
        expect(dots.message.test('xaXb(cx')).toBe(false);
    });

    it('keeps the level and the search together', async () => {
        const find = jest.fn().mockReturnValue({
            sort: () => ({
                skip: () => ({ limit: () => ({ lean: () => [] }) }),
            }),
        });
        const model = { find, countDocuments: jest.fn().mockResolvedValue(0) };
        const service = new LogsQueryService(
            model as never,
            {} as never,
            {} as never,
            {} as never,
            {} as never,
        );
        await service.list(
            { search: 'ab12', level: 'error' } as never,
            { id: 'a', role: 'admin' } as never,
        );
        const filter = find.mock.calls[0][0];
        expect(filter.$and.length).toBeGreaterThanOrEqual(2);
        expect(
            filter.$and.some((part: any) =>
                part.$or?.some((item: any) => 'data.request.id' in item),
            ),
        ).toBe(true);
    });
});
