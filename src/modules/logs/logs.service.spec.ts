import { LogsQueryService } from './logs.service';

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
