import { createHash } from 'crypto';
import {
    BadRequestException,
    Injectable,
    ForbiddenException,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import Redis from 'ioredis';
import { Connection, Model, Types } from 'mongoose';
import type { Request } from 'express';
import { PERMISSIONS } from '../../authz/permissions';
import { hasPermission, type Actor } from '../../authz/policy';
import { clientIp, lookupVisitorGeo } from '../../visitor/geo';
import { AppLog } from '../../database/schemas/log.schema';
import { Post } from '../../database/schemas/post.schema';
import { PostComment } from '../../database/schemas/post-comment.schema';
import { User } from '../../database/schemas/user.schema';
import { Session } from '../../database/schemas/session.schema';
import {
    VisitDay,
    VisitHour,
    VisitPlace,
    VisitUser,
} from '../../database/schemas/visit-bucket.schema';
import { buildInfo } from '../../infra/build-info';
import { appVersion } from '../backups/manifest';
import { RequestMetricsService } from './request-metrics.service';
import { postExcerpt } from '../posts/post-html';

const DEDUPE_SECONDS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const RETENTION_DAYS = 70;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const LEGACY_PAGEVIEWS = 'pageviews';
const LEGACY_PAGEVIEWS_STAGING = 'pageviews_migrating';

type PeriodKey = '24h' | '7' | '30' | 'custom';

type Period = {
    key: PeriodKey;
    granularity: 'hour' | 'day';
    from: Date;
    to: Date;
    days: number;
    prevFrom: Date;
    prevTo: Date;
};

type VisitBucket = {
    authorized?: number;
    anonymous?: number;
    imported_authorized?: number;
    imported_anonymous?: number;
};

@Injectable()
export class AnalyticsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(AnalyticsService.name);
    private readonly redis: Redis;

    constructor(
        config: ConfigService,
        @InjectConnection() private readonly connection: Connection,
        @InjectModel(VisitDay.name) private readonly visitDays: Model<VisitDay>,
        @InjectModel(VisitHour.name)
        private readonly visitHours: Model<VisitHour>,
        @InjectModel(User.name) private readonly users: Model<User>,
        @InjectModel(Post.name) private readonly posts: Model<Post>,
        @InjectModel(PostComment.name)
        private readonly comments: Model<PostComment>,
        @InjectModel(AppLog.name) private readonly logs: Model<AppLog>,
        @InjectModel(Session.name) private readonly sessions: Model<Session>,
        @InjectModel(VisitPlace.name)
        private readonly visitPlaces: Model<VisitPlace>,
        @InjectModel(VisitUser.name)
        private readonly visitUsers: Model<VisitUser>,
        private readonly requestMetrics: RequestMetricsService,
    ) {
        this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
            maxRetriesPerRequest: 1,
            connectTimeout: 1000,
            commandTimeout: 500,
        });
        this.redis.on('error', (error: Error) => {
            this.logger.warn(error.message);
        });
    }

    async onModuleInit() {
        try {
            await this.migrateLegacyPageViews();
        } catch (error) {
            const message =
                error instanceof Error
                    ? error.message
                    : 'pageviews migration failed';
            this.logger.error(message);
        }
    }

    async onModuleDestroy() {
        await this.redis.quit();
    }

    private utcDayString(date: Date) {
        return date.toISOString().slice(0, 10);
    }

    private rangeStart(days: number) {
        const start = new Date();
        start.setUTCHours(0, 0, 0, 0);
        start.setUTCDate(start.getUTCDate() - (days - 1));
        return start;
    }

    private dayKeyExpr(field: string) {
        return {
            $dateToString: {
                format: '%Y-%m-%d',
                date: `$${field}`,
                timezone: 'UTC',
            },
        };
    }

    private dayStart(offsetDays = 0) {
        const day = new Date();
        day.setUTCHours(0, 0, 0, 0);
        day.setUTCDate(day.getUTCDate() + offsetDays);
        return day;
    }

    private resolvePeriod(query: {
        period?: string;
        from?: string;
        to?: string;
    }): Period {
        const key = (query.period || '7') as PeriodKey;

        if (key === '24h') {
            const to = new Date();
            const from = new Date(to.getTime() - DAY_MS);
            return {
                key,
                granularity: 'hour',
                from,
                to,
                days: 1,
                prevFrom: new Date(from.getTime() - DAY_MS),
                prevTo: from,
            };
        }

        let from: Date;
        let days: number;

        if (key === 'custom') {
            if (
                !ISO_DAY.test(query.from || '') ||
                !ISO_DAY.test(query.to || '')
            ) {
                throw new BadRequestException('Pick both dates');
            }
            const start = new Date(`${query.from}T00:00:00.000Z`);
            let end = new Date(`${query.to}T00:00:00.000Z`);
            if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
                throw new BadRequestException('The dates are not valid');
            }
            if (start > end) {
                throw new BadRequestException(
                    'The start date is after the end date',
                );
            }
            const today = this.dayStart();
            if (end > today) {
                end = today;
            }
            if (start > end) {
                throw new BadRequestException('The period is in the future');
            }
            if (start < this.rangeStart(RETENTION_DAYS)) {
                throw new BadRequestException(
                    `Statistics are kept for ${RETENTION_DAYS} days`,
                );
            }
            from = start;
            days = Math.round((end.getTime() - start.getTime()) / DAY_MS) + 1;
        } else {
            days = key === '30' ? 30 : 7;
            from = this.rangeStart(days);
        }

        return {
            key: key === 'custom' ? 'custom' : key === '30' ? '30' : '7',
            granularity: 'day',
            from,
            to: new Date(from.getTime() + days * DAY_MS),
            days,
            prevFrom: new Date(from.getTime() - days * DAY_MS),
            prevTo: from,
        };
    }

    private hourWindow(period: Period) {
        const first =
            period.granularity === 'hour'
                ? new Date(this.hourStart(new Date()).getTime() - 23 * HOUR_MS)
                : period.from;
        const last = new Date(Math.min(period.to.getTime() - 1, Date.now()));
        return { first: this.hourKey(first), last: this.hourKey(last) };
    }

    private fillDaysFrom(
        from: Date,
        days: number,
        maps: Record<string, Map<string, number>>,
    ) {
        const series = [];
        for (let i = 0; i < days; i += 1) {
            const day = new Date(from.getTime() + i * DAY_MS);
            const key = this.utcDayString(day);
            const point: Record<string, unknown> = { date: key };
            for (const [name, map] of Object.entries(maps)) {
                point[name] = map.get(key) || 0;
            }
            series.push(point);
        }
        return series;
    }

    private sanitizePath(path?: string) {
        const raw = String(path || '')
            .split('?')[0]
            .split('#')[0]
            .trim();
        if (!raw.startsWith('/')) return '/';
        return raw.slice(0, 200);
    }

    private resolveVisitorId(actor: Actor | undefined, req: Request) {
        if (actor?.id) {
            return `u:${actor.id}`;
        }

        const ip = clientIp(req);
        const userAgent = String(req.headers['user-agent'] || '');
        const digest = createHash('sha256')
            .update(`${ip}|${userAgent}`)
            .digest('hex')
            .slice(0, 32);

        return `a:${digest}`;
    }

    private fillHours(
        hours: number,
        maps: Record<string, Map<string, number>>,
    ) {
        const end = new Date();
        end.setUTCMinutes(0, 0, 0);
        const series = [];

        for (let offset = hours - 1; offset >= 0; offset -= 1) {
            const point = new Date(end);
            point.setUTCHours(point.getUTCHours() - offset);
            const key = point.toISOString().slice(0, 13);
            const item: Record<string, unknown> = { date: key };

            for (const [name, map] of Object.entries(maps)) {
                item[name] = map.get(key) || 0;
            }

            series.push(item);
        }

        return series;
    }

    async trackVisit(
        body: {
            pagePath?: string;
            pageReferrer?: string;
        },
        actor: Actor | undefined,
        req: Request,
    ) {
        const path = this.sanitizePath(body.pagePath);
        const visitorId = this.resolveVisitorId(actor, req);
        const counted = await this.claimVisit(visitorId, path);
        if (!counted) {
            return { counted: false };
        }

        const now = new Date();
        const bucketAt = this.hourStart(now);
        const field = actor?.id ? 'authorized' : 'anonymous';

        await Promise.all([
            this.visitDays.updateOne(
                { day: this.utcDayString(now) },
                { $inc: { [field]: 1 } },
                { upsert: true },
            ),
            this.visitHours.updateOne(
                { hour: this.hourKey(bucketAt) },
                {
                    $inc: { [field]: 1 },
                    $setOnInsert: { bucket_at: bucketAt },
                },
                { upsert: true },
            ),
        ]);

        void this.recordVisitDetails(bucketAt, actor, req);

        return { counted: true };
    }

    private async recordVisitDetails(
        bucketAt: Date,
        actor: Actor | undefined,
        req: Request,
    ) {
        const hour = this.hourKey(bucketAt);
        try {
            const writes: Promise<unknown>[] = [];
            if (actor?.id) {
                writes.push(
                    this.visitUsers.updateOne(
                        { hour, user: actor.id },
                        { $setOnInsert: { bucket_at: bucketAt } },
                        { upsert: true },
                    ),
                );
            }
            const geo = await lookupVisitorGeo(req);
            writes.push(
                this.visitPlaces.updateOne(
                    {
                        hour,
                        city: geo.city || '',
                        country: geo.country || '',
                    },
                    {
                        $inc: { count: 1 },
                        $setOnInsert: { bucket_at: bucketAt },
                    },
                    { upsert: true },
                ),
            );
            await Promise.all(writes);
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'visit details failed';
            this.logger.warn(message);
        }
    }

    private hourStart(date: Date) {
        const hour = new Date(date);
        hour.setUTCMinutes(0, 0, 0);
        return hour;
    }

    private hourKey(date: Date) {
        return date.toISOString().slice(0, 13);
    }

    private bucketParts(row: VisitBucket) {
        return {
            authorized:
                Number(row.authorized || 0) +
                Number(row.imported_authorized || 0),
            anonymous:
                Number(row.anonymous || 0) +
                Number(row.imported_anonymous || 0),
        };
    }

    private sumBuckets(rows: VisitBucket[]) {
        return rows.reduce<{ authorized: number; anonymous: number }>(
            (total, row) => {
                const parts = this.bucketParts(row);
                total.authorized += parts.authorized;
                total.anonymous += parts.anonymous;
                return total;
            },
            { authorized: 0, anonymous: 0 },
        );
    }

    private async claimVisit(visitorId: string, path: string) {
        try {
            const claimed = await this.redis.set(
                `visit:${visitorId}:${path}`,
                '1',
                'EX',
                DEDUPE_SECONDS,
                'NX',
            );
            return claimed === 'OK';
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'visit dedupe failed';
            this.logger.warn(message);
            return true;
        }
    }

    private async trafficByHour() {
        const end = this.hourStart(new Date());
        const start = new Date(end.getTime() - 23 * HOUR_MS);
        const rows = await this.visitHours
            .find({
                hour: {
                    $gte: this.hourKey(start),
                    $lte: this.hourKey(end),
                },
            })
            .lean();
        const audience = this.sumBuckets(rows);
        const visits = new Map<string, number>();
        const signedIn = new Map<string, number>();
        for (const row of rows) {
            const parts = this.bucketParts(row);
            visits.set(row.hour, parts.authorized + parts.anonymous);
            signedIn.set(row.hour, parts.authorized);
        }

        return {
            visits: audience.authorized + audience.anonymous,
            visits_prev: null as number | null,
            signed_in: audience.authorized,
            anonymous: audience.anonymous,
            series: this.fillHours(24, {
                visits,
                signed_in: signedIn,
            }),
        };
    }

    private async trafficByDay(period: Period) {
        const fromKey = this.utcDayString(period.from);
        const lastKey = this.utcDayString(new Date(period.to.getTime() - 1));
        const rows = await this.visitDays
            .find({
                day: {
                    $gte: this.utcDayString(period.prevFrom),
                    $lte: lastKey,
                },
            })
            .lean();
        const current = rows.filter((row) => row.day >= fromKey);
        const previous = rows.filter((row) => row.day < fromKey);
        const audience = this.sumBuckets(current);
        const before = this.sumBuckets(previous);
        const visits = new Map<string, number>();
        const signedIn = new Map<string, number>();
        for (const row of current) {
            const parts = this.bucketParts(row);
            visits.set(row.day, parts.authorized + parts.anonymous);
            signedIn.set(row.day, parts.authorized);
        }

        return {
            visits: audience.authorized + audience.anonymous,
            visits_prev: (before.authorized + before.anonymous) as
                number | null,
            signed_in: audience.authorized,
            anonymous: audience.anonymous,
            series: this.fillDaysFrom(period.from, period.days, {
                visits,
                signed_in: signedIn,
            }),
        };
    }

    private async activityBetween(from: Date, to: Date) {
        const range = { $gte: from, $lt: to };
        const [registered, logins, posts, comments, likes] = await Promise.all([
            this.users.countDocuments({ created_date: range }),
            this.logs.countDocuments({ type: 'login', date_time: range }),
            this.posts.countDocuments({ created_date: range }),
            this.comments.countDocuments({ created_date: range }),
            this.logs.countDocuments({ type: 'like_post', date_time: range }),
        ]);

        return { registered, logins, posts, comments, likes };
    }

    private async uniqueSignedIn(first: string, last: string) {
        const rows = await this.visitUsers.aggregate<{ n: number }>([
            { $match: { hour: { $gte: first, $lte: last } } },
            { $group: { _id: '$user' } },
            { $count: 'n' },
        ]);
        return rows[0]?.n ?? 0;
    }

    private async placeActivity(first: string, last: string) {
        const rows = await this.visitPlaces.aggregate<{
            _id: { city: string; country: string };
            count: number;
        }>([
            { $match: { hour: { $gte: first, $lte: last } } },
            {
                $group: {
                    _id: { city: '$city', country: '$country' },
                    count: { $sum: '$count' },
                },
            },
        ]);

        let unknown = 0;
        const known: { label: string; count: number }[] = [];
        for (const row of rows) {
            const { city, country } = row._id;
            if (!city && !country) {
                unknown += row.count;
                continue;
            }
            known.push({
                label: city
                    ? [city, country].filter(Boolean).join(', ')
                    : country,
                count: row.count,
            });
        }

        known.sort(
            (a, b) => b.count - a.count || a.label.localeCompare(b.label),
        );
        const total = known.reduce((sum, place) => sum + place.count, 0);
        const withShare = (place: { label: string; count: number }) => ({
            ...place,
            share: total ? place.count / total : 0,
        });

        return {
            top: known.slice(0, 8).map(withShare),
            total_places: known.length,
            located_visits: total,
            unknown_visits: unknown,
        };
    }

    async getDashboard(
        query: { period?: string; from?: string; to?: string },
        actor: Actor,
    ) {
        if (!hasPermission(actor, PERMISSIONS.VIEW_LOGS)) {
            throw new ForbiddenException(
                "You don't have permission to view analytics",
            );
        }

        const period = this.resolvePeriod(query);
        const window = this.hourWindow(period);
        const inPeriod = {
            created_date: { $gte: period.from, $lt: period.to },
        };

        const [
            traffic,
            now,
            before,
            places,
            uniqueUsers,
            timings,
            totals,
            topPosts,
            contentTags,
        ] = await Promise.all([
            period.granularity === 'hour'
                ? this.trafficByHour()
                : this.trafficByDay(period),
            this.activityBetween(period.from, period.to),
            this.activityBetween(period.prevFrom, period.prevTo),
            this.placeActivity(window.first, window.last),
            this.uniqueSignedIn(window.first, window.last),
            this.requestMetrics.summary(
                window.first,
                period.granularity === 'hour' ? 13 : 10,
                window.last,
            ),
            Promise.all([
                this.users.countDocuments(),
                this.posts.countDocuments(),
                this.comments.countDocuments(),
                this.likesTotal(),
            ]),
            this.posts
                .find({ views_count: { $gt: 0 } })
                .select('_id content_text views_count')
                .sort({ views_count: -1 })
                .limit(5)
                .lean(),
            this.contentHashtags(5),
        ]);

        const totalVisits = traffic.signed_in + traffic.anonymous;

        return {
            period: {
                key: period.key,
                granularity: period.granularity,
                from: period.from,
                to: period.to,
                days: period.days,
                previous: { from: period.prevFrom, to: period.prevTo },
                retention_days: RETENTION_DAYS,
            },
            traffic: {
                visits: traffic.visits,
                visits_prev: traffic.visits_prev,
                signed_in: traffic.signed_in,
                signed_in_share: totalVisits
                    ? traffic.signed_in / totalVisits
                    : 0,
                unique_signed_in: uniqueUsers,
                series: traffic.series,
            },
            people: {
                registered: now.registered,
                registered_prev: before.registered,
                logins: now.logins,
                logins_prev: before.logins,
            },
            content: {
                posts: now.posts,
                posts_prev: before.posts,
                comments: now.comments,
                comments_prev: before.comments,
                likes: now.likes,
                likes_prev: before.likes,
            },
            places,
            performance: {
                ...timings.overall,
                slowest: timings.slowest,
                heaviest: timings.heaviest,
                series: traffic.series.map((point) => {
                    const date = String(point.date);
                    const entry = timings.series.get(date);
                    return {
                        date,
                        avg_ms: entry?.avg_ms ?? 0,
                        db_ms: entry?.db_ms ?? 0,
                    };
                }),
            },
            overview: {
                users: totals[0],
                posts: totals[1],
                comments: totals[2],
                likes: totals[3],
                top_posts: (
                    topPosts as Array<{
                        _id: unknown;
                        content_text?: string;
                        views_count?: number;
                    }>
                ).map((post) => ({
                    _id: post._id,
                    title: postExcerpt(post.content_text),
                    excerpt: postExcerpt(post.content_text),
                    views_count: Number(post.views_count || 0),
                })),
                top_hashtags: contentTags.top as Array<{
                    tag: string;
                    uses: number;
                    posts: number;
                    comments: number;
                }>,
            },
        };
    }

    appInfo(actor: Actor) {
        if (!hasPermission(actor, PERMISSIONS.VIEW_LOGS)) {
            throw new ForbiddenException(
                "You don't have permission to view this",
            );
        }

        return {
            version: appVersion(),
            sha: buildInfo().sha_short,
            started_at: new Date(Date.now() - process.uptime() * 1000),
        };
    }

    private extractHashtags(text: string) {
        const plain = String(text || '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&[a-zA-Z0-9#]+;/g, ' ')
            .toLowerCase();
        return plain.match(/#[^\s#]+/g) || [];
    }

    private async contentHashtags(limit = 5) {
        const [postDocs, commentDocs] = await Promise.all([
            this.posts
                .find({
                    content_text: { $regex: '#' },
                })
                .select('content_text')
                .lean(),
            this.comments
                .find({ comment_text: { $regex: '#' } })
                .select('comment_text')
                .lean(),
        ]);

        const postsByTag = new Map<string, number>();
        const commentsByTag = new Map<string, number>();
        let postsWithTags = 0;

        for (const post of postDocs) {
            const tags = [
                ...new Set(this.extractHashtags(`${post.content_text || ''}`)),
            ];
            if (!tags.length) {
                continue;
            }
            postsWithTags += 1;
            for (const tag of tags) {
                postsByTag.set(tag, (postsByTag.get(tag) || 0) + 1);
            }
        }

        for (const comment of commentDocs) {
            const tags = [
                ...new Set(this.extractHashtags(comment.comment_text || '')),
            ];
            for (const tag of tags) {
                commentsByTag.set(tag, (commentsByTag.get(tag) || 0) + 1);
            }
        }

        const tags = new Set([...postsByTag.keys(), ...commentsByTag.keys()]);
        const top = [...tags]
            .map((tag) => ({
                tag,
                posts: postsByTag.get(tag) || 0,
                comments: commentsByTag.get(tag) || 0,
                uses:
                    (postsByTag.get(tag) || 0) + (commentsByTag.get(tag) || 0),
            }))
            .sort((a, b) => b.uses - a.uses || b.posts - a.posts)
            .slice(0, limit);

        return {
            top,
            posts_with_hashtags: postsWithTags,
            unique_hashtags: tags.size,
        };
    }

    private async migrateLegacyPageViews() {
        const db = this.connection.db;
        if (!db) {
            return;
        }

        const has = async (name: string) =>
            (await db.listCollections({ name }).toArray()).length > 0;

        if (await has(LEGACY_PAGEVIEWS_STAGING)) {
            await this.foldLegacyPageViews(LEGACY_PAGEVIEWS_STAGING);
        }

        if (!(await has(LEGACY_PAGEVIEWS))) {
            return;
        }

        const legacy = db.collection(LEGACY_PAGEVIEWS);
        if ((await legacy.estimatedDocumentCount()) === 0) {
            await legacy.drop();
            return;
        }

        await legacy.rename(LEGACY_PAGEVIEWS_STAGING);
        await this.foldLegacyPageViews(LEGACY_PAGEVIEWS_STAGING);
    }

    private async foldLegacyPageViews(sourceName: string) {
        const db = this.connection.db;
        if (!db) {
            return;
        }

        const source = db.collection(sourceName);
        const group = {
            authorized: {
                $sum: {
                    $cond: [
                        { $ne: [{ $ifNull: ['$user', null] }, null] },
                        1,
                        0,
                    ],
                },
            },
            anonymous: {
                $sum: {
                    $cond: [
                        { $eq: [{ $ifNull: ['$user', null] }, null] },
                        1,
                        0,
                    ],
                },
            },
        };
        const days = await source
            .aggregate<{
                _id: string;
                authorized: number;
                anonymous: number;
            }>([
                {
                    $group: {
                        _id: this.dayKeyExpr('created_at'),
                        ...group,
                    },
                },
            ])
            .toArray();
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        const hours = await source
            .aggregate<{
                _id: string;
                authorized: number;
                anonymous: number;
            }>([
                { $match: { created_at: { $gte: since } } },
                {
                    $group: {
                        _id: {
                            $dateToString: {
                                format: '%Y-%m-%dT%H',
                                date: '$created_at',
                                timezone: 'UTC',
                            },
                        },
                        ...group,
                    },
                },
            ])
            .toArray();

        if (days.length) {
            await this.visitDays.bulkWrite(
                days.map((row) => ({
                    updateOne: {
                        filter: { day: row._id },
                        update: {
                            $set: {
                                imported_authorized: row.authorized,
                                imported_anonymous: row.anonymous,
                            },
                        },
                        upsert: true,
                    },
                })),
            );
        }

        if (hours.length) {
            await this.visitHours.bulkWrite(
                hours.map((row) => ({
                    updateOne: {
                        filter: { hour: row._id },
                        update: {
                            $set: {
                                imported_authorized: row.authorized,
                                imported_anonymous: row.anonymous,
                            },
                            $setOnInsert: {
                                bucket_at: new Date(`${row._id}:00:00.000Z`),
                            },
                        },
                        upsert: true,
                    },
                })),
            );
        }

        await source.drop();
        this.logger.log(
            `folded ${days.length} daily buckets from legacy pageviews`,
        );
    }

    private async likesTotal() {
        const [posts, comments] = await Promise.all([
            this.posts.aggregate([
                { $project: { n: { $size: { $ifNull: ['$likes', []] } } } },
                { $group: { _id: null, count: { $sum: '$n' } } },
            ]),
            this.comments.aggregate([
                { $project: { n: { $size: { $ifNull: ['$likes', []] } } } },
                { $group: { _id: null, count: { $sum: '$n' } } },
            ]),
        ]);
        return (posts[0]?.count || 0) + (comments[0]?.count || 0);
    }
}
