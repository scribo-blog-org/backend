const apply = typeof APPLY !== 'undefined' && APPLY === true;
const HEX = '^[a-fA-F0-9]{24}$';

const convert = (expr) => ({
    $cond: [
        {
            $and: [
                { $eq: [{ $type: expr }, 'string'] },
                { $regexMatch: { input: expr, regex: HEX } },
            ],
        },
        { $toObjectId: expr },
        expr,
    ],
});

const convertArray = (expr) => ({
    $cond: [
        { $isArray: expr },
        { $map: { input: expr, as: 'item', in: convert('$$item') } },
        expr,
    ],
});

const convertFields = (base, fields) =>
    Object.fromEntries(fields.map((f) => [f, convert(`${base}.${f}`)]));

const TARGETS = [
    { collection: 'posts', scalars: ['author'], arrays: ['likes'] },
    {
        collection: 'users',
        arrays: ['saved_posts', 'follows', 'followers'],
        subdocs: [
            { path: 'notifications', fields: ['user', 'post', 'comment'] },
        ],
    },
    {
        collection: 'post_comments',
        scalars: ['author', 'post_id', 'parent_comment_id'],
        arrays: ['likes'],
    },
    {
        collection: 'chat_messages',
        scalars: ['conversation_id', 'sender_id', 'reply_to'],
    },
    {
        collection: 'conversations',
        scalars: ['last_message_id'],
        arrays: ['participants'],
        subdocs: [{ path: 'members', fields: ['user_id'] }],
    },
    { collection: 'sessions', scalars: ['user'] },
    { collection: 'push_subscriptions', scalars: ['user'] },
    { collection: 'backups', scalars: ['triggered_by'] },
    { collection: 'supportrequests', scalars: ['user'] },
];

const stringPaths = (target) => [
    ...(target.scalars || []),
    ...(target.arrays || []),
    ...(target.subdocs || []).flatMap((sub) =>
        sub.fields.map((field) => `${sub.path}.${field}`),
    ),
];

const needsWork = (target) => ({
    $or: stringPaths(target).map((path) => ({ [path]: { $type: 'string' } })),
});

const update = (target) => {
    const set = {};

    for (const field of target.scalars || []) {
        set[field] = convert(`$${field}`);
    }
    for (const field of target.arrays || []) {
        set[field] = convertArray(`$${field}`);
    }
    for (const sub of target.subdocs || []) {
        set[sub.path] = {
            $cond: [
                { $isArray: `$${sub.path}` },
                {
                    $map: {
                        input: `$${sub.path}`,
                        as: 'row',
                        in: {
                            $mergeObjects: [
                                '$$row',
                                convertFields('$$row', sub.fields),
                            ],
                        },
                    },
                },
                `$${sub.path}`,
            ],
        };
    }

    return [{ $set: set }];
};

const typeReport = (target) => {
    const report = {};

    for (const path of stringPaths(target)) {
        const rows = db
            .getCollection(target.collection)
            .aggregate([
                { $project: { value: `$${path}` } },
                {
                    $unwind: {
                        path: '$value',
                        preserveNullAndEmptyArrays: false,
                    },
                },
                {
                    $unwind: {
                        path: '$value',
                        preserveNullAndEmptyArrays: false,
                    },
                },
                { $group: { _id: { $type: '$value' }, n: { $sum: 1 } } },
            ])
            .toArray();

        report[path] = Object.fromEntries(rows.map((row) => [row._id, row.n]));
    }

    return report;
};

print(apply ? 'APPLY mode' : 'DRY RUN (nothing is changed)');

for (const target of TARGETS) {
    const collection = db.getCollection(target.collection);
    const filter = needsWork(target);
    const pending = collection.countDocuments(filter);

    print(
        `\n${target.collection}: ${pending} document(s) with string references`,
    );
    printjson(typeReport(target));

    if (apply && pending > 0) {
        const result = collection.updateMany(filter, update(target));
        print(`  modified ${result.modifiedCount}`);
    }
}

if (apply) {
    print('\nRemaining strings (not 24-hex, left untouched):');

    for (const target of TARGETS) {
        const left = db
            .getCollection(target.collection)
            .countDocuments(needsWork(target));

        if (left > 0) {
            print(`  ${target.collection}: ${left}`);
        }
    }
}
