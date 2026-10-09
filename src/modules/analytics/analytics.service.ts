import { createHash } from 'crypto';
import {
    Injectable,
    ForbiddenException,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import Redis from 'ioredis';
import { Connection, Model } from 'mongoose';
import type { Request } from 'express';
import { PERMISSIONS } from '../../authz/permissions';
import { hasPermission, type Actor } from '../../authz/policy';
import { clientIp, lookupVisitorGeo } from '../../visitor/geo';
import { AppLog } from '../../database/schemas/log.schema';
import { Category } from '../../database/schemas/category.schema';
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

const DEDUPE_SECONDS = 8;
const HEALTH_TYPES = [
    'server_error',
    'slow_request',
    'rate_limited',
    'access_denied',
    'external_failed',
];
const DAY_MS = 24 * 60 * 60 * 1000;
const repeated = { $add: [1, { $ifNull: ['$data.repeats', 0] }] };
const LEGACY_PAGEVIEWS = 'pageviews';
const LEGACY_PAGEVIEWS_STAGING = 'pageviews_migrating';

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
        @InjectModel(Category.name)
        private readonly categories: Model<Category>,
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

    private hoursAgo(hours: number) {
        return new Date(Date.now() - hours * 60 * 60 * 1000);
    }

    private dateRangeFilter(from: Date, to?: Date) {
        if (to) {
            return { $gte: from, $lt: to };
        }

        return { $gte: from };
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

    private parsePeriod(value?: string) {
        if (value === '24h') {
            return { mode: 'hours' as const, hours: 24, key: '24h' as const };
        }

        const days = Number.parseInt(String(value || '14'), 10);
        const normalized = [7, 14, 30].includes(days) ? days : 14;
        return {
            mode: 'days' as const,
            days: normalized,
            key: normalized,
        };
    }

    private sanitizePath(path?: string) {
        const raw = String(path || '')
            .split('?')[0]
            .split('#')[0]
            .trim();
        if (!raw.startsWith('/')) return '/';
        return raw.slice(0, 200);
    }

    private toMap(rows: { _id: string; count: number }[]) {
        const map = new Map<string, number>();
        for (const row of rows) map.set(row._id, row.count);
        return map;
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

    private fillDays(days: number, maps: Record<string, Map<string, number>>) {
        const start = this.rangeStart(days);
        const series = [];
        for (let i = 0; i < days; i += 1) {
            const day = new Date(start);
            day.setUTCDate(start.getUTCDate() + i);
            const key = this.utcDayString(day);
            const point: Record<string, unknown> = { date: key };
            for (const [name, map] of Object.entries(maps)) {
                point[name] = map.get(key) || 0;
            }
            series.push(point);
        }
        return series;
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

    private async periodActivity(from: Date, to?: Date) {
        const dateFilter = this.dateRangeFilter(from, to);

        const [logRows, commentsCreated, logins, newUsers] = await Promise.all([
            this.logs.aggregate([
                {
                    $match: {
                        date_time: dateFilter,
                        type: {
                            $in: [
                                'create_post',
                                'update_post',
                                'delete_post',
                                'register',
                                'comment_post',
                                'reply_comment',
                                'update_comment',
                                'delete_comment',
                                'like_post',
                            ],
                        },
                    },
                },
                { $group: { _id: '$type', count: { $sum: 1 } } },
            ]),
            this.comments.countDocuments({ created_date: dateFilter }),
            this.sessions.countDocuments({ createdAt: dateFilter }),
            this.users.countDocuments({ created_date: dateFilter }),
        ]);

        const counts = new Map(
            (logRows as { _id: string; count: number }[]).map((row) => [
                row._id,
                row.count,
            ]),
        );

        const commentsWritten =
            commentsCreated ||
            (counts.get('comment_post') || 0) +
                (counts.get('reply_comment') || 0);

        return {
            posts: {
                created: counts.get('create_post') || 0,
                updated: counts.get('update_post') || 0,
                deleted: counts.get('delete_post') || 0,
            },
            users: {
                registered: newUsers || counts.get('register') || 0,
                logins,
            },
            comments: {
                created: commentsWritten,
                updated: counts.get('update_comment') || 0,
                deleted: counts.get('delete_comment') || 0,
            },
            likes: {
                posts: counts.get('like_post') || 0,
            },
        };
    }

    private async healthSummary(from: Date) {
        const now = Date.now();
        const dayAgo = new Date(now - DAY_MS);
        const [counts, topErrors, slowRequests, slowQueries, deploys, backup] =
            await Promise.all([
                this.logs.aggregate<{
                    _id: { type: string; current: boolean };
                    count: number;
                }>([
                    {
                        $match: {
                            type: { $in: HEALTH_TYPES },
                            date_time: { $gte: new Date(now - 2 * DAY_MS) },
                        },
                    },
                    {
                        $group: {
                            _id: {
                                type: '$type',
                                current: { $gte: ['$date_time', dayAgo] },
                            },
                            count: { $sum: repeated },
                        },
                    },
                ]),
                this.logs.aggregate([
                    {
                        $match: {
                            type: 'server_error',
                            date_time: { $gte: from },
                        },
                    },
                    {
                        $group: {
                            _id: {
                                method: '$data.method',
                                path: '$data.path',
                                error: '$data.error',
                            },
                            count: { $sum: repeated },
                            first_at: { $min: '$date_time' },
                            last_at: { $max: '$date_time' },
                            status: { $last: '$data.status' },
                        },
                    },
                    { $sort: { count: -1, last_at: -1 } },
                    { $limit: 6 },
                ]),
                this.logs
                    .find({ type: 'slow_request', date_time: { $gte: from } })
                    .sort({ date_time: -1 })
                    .limit(5)
                    .lean(),
                this.logs.aggregate([
                    {
                        $match: {
                            type: 'slow_query',
                            date_time: { $gte: from },
                        },
                    },
                    {
                        $group: {
                            _id: {
                                collection: '$data.collection',
                                operation: '$data.operation',
                            },
                            count: { $sum: repeated },
                            max_ms: { $max: '$data.duration_ms' },
                            last_at: { $max: '$date_time' },
                        },
                    },
                    { $sort: { count: -1 } },
                    { $limit: 5 },
                ]),
                this.logs
                    .find({ type: 'server_start', date_time: { $gte: from } })
                    .sort({ date_time: -1 })
                    .limit(6)
                    .select('date_time data.version data.sha_short data.env')
                    .lean(),
                this.logs
                    .findOne({
                        type: { $in: ['backup_done', 'backup_failed'] },
                    })
                    .sort({ date_time: -1 })
                    .select('type date_time message data.file_name data.error')
                    .lean(),
            ]);

        const counters: Record<string, { current: number; previous: number }> =
            Object.fromEntries(
                HEALTH_TYPES.map((type) => [type, { current: 0, previous: 0 }]),
            );
        for (const row of counts) {
            counters[row._id.type][row._id.current ? 'current' : 'previous'] =
                row.count;
        }

        return {
            counters,
            top_errors: topErrors.map((row) => ({
                method: row._id.method,
                path: row._id.path,
                error: row._id.error,
                status: row.status,
                count: row.count,
                first_at: row.first_at,
                last_at: row.last_at,
            })),
            slow_requests: slowRequests,
            slow_queries: slowQueries.map((row) => ({
                collection: row._id.collection,
                operation: row._id.operation,
                count: row.count,
                max_ms: row.max_ms,
                last_at: row.last_at,
            })),
            deploys,
            last_backup: backup,
        };
    }

    async getDashboard(query: { days?: string }, actor: Actor) {
        if (!hasPermission(actor, PERMISSIONS.VIEW_LOGS)) {
            throw new ForbiddenException(
                "You don't have permission to view analytics",
            );
        }

        const period = this.parsePeriod(query.days);
        const from =
            period.mode === 'hours'
                ? this.hoursAgo(period.hours)
                : this.rangeStart(period.days);
        const firstHour = this.hourKey(
            period.mode === 'hours'
                ? new Date(
                      this.hourStart(new Date()).getTime() -
                          (period.hours - 1) * 60 * 60 * 1000,
                  )
                : this.rangeStart(period.days),
        );
        const traffic = await this.trafficTotals(period);
        const [
            contentTags,
            topPosts,
            activity,
            places,
            uniqueUsers,
            timings,
            health,
        ] = await Promise.all([
            this.contentHashtags(5),
            this.posts
                .find({ views_count: { $gt: 0 } })
                .select('_id title views_count')
                .sort({ views_count: -1 })
                .limit(5)
                .lean(),
            this.periodActivity(from),
            this.placeActivity(firstHour),
            this.uniqueSignedIn(firstHour),
            this.requestMetrics.summary(
                firstHour,
                period.mode === 'hours' ? 13 : 10,
            ),
            this.healthSummary(from),
        ]);

        const totalVisits =
            traffic.authorized_visits + traffic.anonymous_visits;

        return {
            days: period.key,
            totals: {
                visits: traffic.visits,
                visits_prev: traffic.visits_prev,
            },
            series: traffic.series,
            activity,
            audience: {
                authorized_visits: traffic.authorized_visits,
                anonymous_visits: traffic.anonymous_visits,
                authorized_share: totalVisits
                    ? traffic.authorized_visits / totalVisits
                    : 0,
                unique_authorized: uniqueUsers,
            },
            places,
            app: {
                version: appVersion(),
                sha: buildInfo().sha_short,
                started_at: new Date(Date.now() - process.uptime() * 1000),
            },
            health,
            timings: {
                ...timings.overall,
                slowest: timings.slowest,
                heaviest: timings.heaviest,
                chatty: timings.chatty,
                failing: timings.failing,
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
            top_posts: (
                topPosts as Array<{
                    _id: unknown;
                    title: string;
                    views_count?: number;
                }>
            ).map((post) => ({
                _id: post._id,
                title: post.title,
                views_count: Number(post.views_count || 0),
            })),
            top_hashtags: contentTags.top as Array<{
                tag: string;
                uses: number;
                posts: number;
                comments: number;
            }>,
        };
    }

    private async uniqueSignedIn(firstHour: string) {
        const rows = await this.visitUsers.aggregate<{ n: number }>([
            { $match: { hour: { $gte: firstHour } } },
            { $group: { _id: '$user' } },
            { $count: 'n' },
        ]);
        return rows[0]?.n ?? 0;
    }

    private async placeActivity(firstHour: string) {
        const rows = await this.visitPlaces.aggregate<{
            _id: { city: string; country: string };
            count: number;
        }>([
            { $match: { hour: { $gte: firstHour } } },
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
        const top = known.slice(0, 8);
        const bottom = known.slice(top.length).reverse().slice(0, 5);

        return {
            top: top.map(withShare),
            bottom: bottom.map(withShare),
            total_places: known.length,
            located_visits: total,
            unknown_visits: unknown,
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
                    $or: [
                        { title: { $regex: '#' } },
                        { content_text: { $regex: '#' } },
                    ],
                })
                .select('title content_text')
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
                ...new Set(
                    this.extractHashtags(
                        `${post.title} ${post.content_text || ''}`,
                    ),
                ),
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

    private async trafficTotals(period: {
        mode: 'hours' | 'days';
        hours?: number;
        days?: number;
    }) {
        if (period.mode === 'hours') {
            const end = this.hourStart(new Date());
            const start = new Date(end);
            start.setUTCHours(start.getUTCHours() - ((period.hours || 24) - 1));
            const rows = await this.visitHours
                .find({
                    hour: {
                        $gte: this.hourKey(start),
                        $lte: this.hourKey(end),
                    },
                })
                .lean();
            const audience = this.sumBuckets(rows);
            const visitMap = new Map(
                rows.map((row) => [
                    row.hour,
                    this.bucketParts(row).authorized +
                        this.bucketParts(row).anonymous,
                ]),
            );

            return {
                visits: audience.authorized + audience.anonymous,
                visits_prev: null,
                authorized_visits: audience.authorized,
                anonymous_visits: audience.anonymous,
                series: this.fillHours(period.hours || 24, {
                    visits: visitMap,
                }),
            };
        }

        const days = period.days || 14;
        const from = this.utcDayString(this.rangeStart(days));
        const previousFrom = this.utcDayString(this.rangeStart(days * 2));
        const rows = await this.visitDays
            .find({ day: { $gte: previousFrom } })
            .lean();
        const current = rows.filter((row) => row.day >= from);
        const previous = rows.filter((row) => row.day < from);
        const audience = this.sumBuckets(current);
        const previousAudience = this.sumBuckets(previous);
        const visitMap = new Map(
            current.map((row) => [
                row.day,
                this.bucketParts(row).authorized +
                    this.bucketParts(row).anonymous,
            ]),
        );

        return {
            visits: audience.authorized + audience.anonymous,
            visits_prev:
                previousAudience.authorized + previousAudience.anonymous,
            authorized_visits: audience.authorized,
            anonymous_visits: audience.anonymous,
            series: this.fillDays(days, { visits: visitMap }),
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
