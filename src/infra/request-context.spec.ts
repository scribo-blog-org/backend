import { requestMeta, unionMs } from './request-context';
import { filterShape } from '../database/db-timing.plugin';

describe('unionMs', () => {
    it('does not count overlapping queries twice', () => {
        expect(
            unionMs([
                [0, 10],
                [5, 15],
                [20, 25],
            ]),
        ).toBe(20);
    });

    it('is zero without queries', () => {
        expect(unionMs([])).toBe(0);
    });
});

describe('requestMeta', () => {
    const req = (headers: Record<string, string>) =>
        ({ method: 'GET', originalUrl: '/a?b=1', headers }) as never;

    it('keeps a sane incoming request id', () => {
        expect(requestMeta(req({ 'x-request-id': 'abc-123_XYZ' })).id).toBe(
            'abc-123_XYZ',
        );
    });

    it('ignores an incoming id that could break a log line', () => {
        const id = requestMeta(req({ 'x-request-id': 'a b\nc' })).id;
        expect(id).toMatch(/^[0-9a-f]{12}$/);
    });
});

describe('filterShape', () => {
    it('keeps keys and operators but drops values', () => {
        expect(
            filterShape({ user: 'u1', age: { $gt: 18 }, tags: { $in: ['a'] } }),
        ).toEqual({ user: '?', age: { $gt: '?' }, tags: { $in: ['?'] } });
    });
});
