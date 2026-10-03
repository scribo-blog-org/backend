import type { PipelineStage } from 'mongoose';

export type LogEntityType = 'user' | 'post' | 'category';

export type LogEntity = {
    type: LogEntityType;
    id: string;
    name: string;
    count: number;
    last: Date;
};

export type EntityCollections = {
    users: string;
    posts: string;
    categories: string;
};

export function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const entry = (type: LogEntityType, id: string, name: string) => ({
    type,
    id: { $toString: id },
    name,
});

const live = (from: string, field: string, as: string): PipelineStage[] => [
    {
        $lookup: {
            from,
            let: {
                id: {
                    $convert: {
                        input: '$_id.id',
                        to: 'objectId',
                        onError: null,
                        onNull: null,
                    },
                },
            },
            pipeline: [
                { $match: { $expr: { $eq: ['$_id', '$$id'] } } },
                { $project: { _id: 0, name: `$${field}` } },
            ],
            as,
        },
    },
];

export function entitiesPipeline(options: {
    regex: RegExp | null;
    collections: EntityCollections;
    skip: number;
    limit: number;
}): PipelineStage[] {
    const { regex, collections, skip, limit } = options;

    return [
        {
            $project: {
                date: '$date_time',
                e: [
                    entry('user', '$data.user', '$data.user_nick'),
                    entry('user', '$data.target_user', '$data.target_nick'),
                    entry('user', '$data.updated_user', '$data.target_nick'),
                    entry('post', '$data.post', '$data.post_title'),
                    entry(
                        'category',
                        '$data.category',
                        '$data.category_snapshot.name',
                    ),
                ],
            },
        },
        { $unwind: '$e' },
        { $match: { 'e.id': { $nin: [null, ''] } } },
        {
            $addFields: {
                hasName: { $cond: [{ $ifNull: ['$e.name', false] }, 1, 0] },
            },
        },
        { $sort: { hasName: -1 as const, date: -1 as const } },
        {
            $group: {
                _id: { type: '$e.type', id: '$e.id' },
                snapshot: { $first: '$e.name' },
                last: { $max: '$date' },
                count: { $sum: 1 },
            },
        },
        ...live(collections.users, 'nick_name', 'liveUser'),
        ...live(collections.posts, 'title', 'livePost'),
        ...live(collections.categories, 'name', 'liveCategory'),
        {
            $addFields: {
                name: {
                    $ifNull: [
                        {
                            $switch: {
                                branches: [
                                    {
                                        case: { $eq: ['$_id.type', 'user'] },
                                        then: {
                                            $arrayElemAt: ['$liveUser.name', 0],
                                        },
                                    },
                                    {
                                        case: { $eq: ['$_id.type', 'post'] },
                                        then: {
                                            $arrayElemAt: ['$livePost.name', 0],
                                        },
                                    },
                                ],
                                default: {
                                    $arrayElemAt: ['$liveCategory.name', 0],
                                },
                            },
                        },
                        '$snapshot',
                    ],
                },
            },
        },
        {
            $match: {
                name: regex ? { $regex: regex } : { $nin: [null, ''] },
            },
        },
        { $sort: { last: -1 as const, '_id.id': 1 as const } },
        {
            $facet: {
                items: [
                    { $skip: skip },
                    { $limit: limit },
                    {
                        $project: {
                            liveUser: 0,
                            livePost: 0,
                            liveCategory: 0,
                            snapshot: 0,
                        },
                    },
                ],
                total: [{ $count: 'n' }],
            },
        },
    ];
}

type GroupRow = {
    _id: { type: LogEntityType; id: string };
    name: string;
    last: Date;
    count: number;
};

export function toEntities(rows: GroupRow[]): LogEntity[] {
    return rows.map((row) => ({
        type: row._id.type,
        id: row._id.id,
        name: row.name,
        count: row.count,
        last: row.last,
    }));
}
