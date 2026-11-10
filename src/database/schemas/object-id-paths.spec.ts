import 'reflect-metadata';
import { Schema, SchemaType } from 'mongoose';
import { BackupSchema } from './backup.schema';
import { ChatMessageSchema } from './chat-message.schema';
import { ConversationSchema } from './conversation.schema';
import { PostCommentSchema } from './post-comment.schema';
import { PostSchema } from './post.schema';
import { PushSubscriptionSchema } from './push-subscription.schema';
import { SessionSchema } from './session.schema';
import { SupportRequestSchema } from './support-request.schema';
import { UserSchema } from './user.schema';

const SCHEMAS: Record<string, Schema> = {
    backup: BackupSchema,
    chat_message: ChatMessageSchema,
    conversation: ConversationSchema,
    post_comment: PostCommentSchema,
    post: PostSchema,
    push_subscription: PushSubscriptionSchema,
    session: SessionSchema,
    support_request: SupportRequestSchema,
    user: UserSchema,
};

type WithOptions = { options?: { ref?: unknown; type?: unknown } };

const elementOf = (type: SchemaType): SchemaType =>
    (type as { embeddedSchemaType?: SchemaType }).embeddedSchemaType ?? type;

const referencePaths = (schema: Schema) => {
    const found: Array<{ path: string; type: SchemaType }> = [];
    schema.eachPath((path, type) => {
        const own = (type as WithOptions).options;
        const inner = (elementOf(type) as WithOptions).options;

        if (own?.ref || inner?.ref) {
            found.push({ path, type });
        }
    });
    return found;
};

describe('ObjectId schema paths', () => {
    it.each(Object.entries(SCHEMAS))(
        'casts every reference in %s to an ObjectId',
        (_name, schema) => {
            const paths = referencePaths(schema);

            expect(paths.length).toBeGreaterThan(0);

            for (const { path, type } of paths) {
                const element = elementOf(type);

                expect({ path, instance: element.instance }).toEqual({
                    path,
                    instance: 'ObjectId',
                });
            }
        },
    );

    it('also covers paths without a ref and sub-document members', () => {
        expect(PostCommentSchema.path('parent_comment_id').instance).toBe(
            'ObjectId',
        );

        const members = ConversationSchema.path('members') as unknown as {
            schema: Schema;
        };

        expect(members.schema.path('user_id').instance).toBe('ObjectId');
    });

    it('stores a string author of a post as an ObjectId', () => {
        const author = PostSchema.path('author').cast(
            '66201abf9a28c513e7f3ded3',
        );

        expect(typeof author).toBe('object');
        expect(String(author)).toBe('66201abf9a28c513e7f3ded3');
    });
});
