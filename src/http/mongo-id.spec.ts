import { isMongoObjectId, requireMongoId } from './mongo-id';
import { FieldException } from './http-errors';

describe('mongo-id', () => {
    it('accepts a 24-character hex ObjectId', () => {
        expect(isMongoObjectId('66b8787ab32781dff28fefef')).toBe(true);
    });

    it('rejects a hex id with a trailing Cyrillic letter', () => {
        expect(isMongoObjectId('66b8787ab32781dff28fefefв')).toBe(false);
    });

    it('rejects 12-character strings that mongoose.isValid would allow', () => {
        expect(isMongoObjectId('not-an-object')).toBe(false);
    });

    it('throws Incorrect type for invalid ids', () => {
        expect(() => requireMongoId('66b8787ab32781dff28fefefв')).toThrow(
            FieldException,
        );
    });
});
