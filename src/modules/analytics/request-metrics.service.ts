import {
    Injectable,
    Logger,
    OnModuleDestroy,
    OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import type { RequestSample } from '../../infra/request-context';
import { RequestMetricHour } from '../../database/schemas/request-metric.schema';
import {
    LATENCY_BUCKETS,
    describeLoad,
    describeTimings,
    isTrackedRoute,
    latencyBucket,
    type RouteTotals,
} from './request-metrics';

const FLUSH_INTERVAL_MS = 10_000;
const MAX_PENDING_KEYS = 2000;

type Pending = {
    hour: string;
    route: string;
    count: number;
    total_ms: number;
    db_ms: number;
    max_ms: number;
    histogram: number[];
    queries: number;
    errors: number;
    client_errors: number;
};

type StoredRow = {
    hour: string;
    route: string;
    count: number;
    total_ms: number;
    db_ms: number;
    max_ms: number;
    queries?: number;
    errors?: number;
    client_errors?: number;
    h?: Record<string, number>;
};

const histogramOf = (row: StoredRow) =>
    Array.from({ length: LATENCY_BUCKETS }, (_, i) => row.h?.[String(i)] || 0);

@Injectable()
export class RequestMetricsService implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(RequestMetricsService.name);
    private pending = new Map<string, Pending>();
    private timer?: NodeJS.Timeout;

    constructor(
        @InjectModel(RequestMetricHour.name)
        private readonly metrics: Model<RequestMetricHour>,
    ) {}

    onModuleInit() {
        this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
        this.timer.unref();
    }

    async onModuleDestroy() {
        if (this.timer) clearInterval(this.timer);
        await this.flush();
    }

    record(
        sample: Pick<RequestSample, 'route' | 'total_ms' | 'db_ms'> &
            Partial<Pick<RequestSample, 'status' | 'db_queries'>>,
    ) {
        if (!isTrackedRoute(sample.route)) return;

        const hour = new Date().toISOString().slice(0, 13);
        const key = `${hour}|${sample.route}`;
        let entry = this.pending.get(key);
        if (!entry) {
            if (this.pending.size >= MAX_PENDING_KEYS) return;
            entry = {
                hour,
                route: sample.route,
                count: 0,
                total_ms: 0,
                db_ms: 0,
                max_ms: 0,
                histogram: new Array<number>(LATENCY_BUCKETS).fill(0),
                queries: 0,
                errors: 0,
                client_errors: 0,
            };
            this.pending.set(key, entry);
        }

        entry.count += 1;
        entry.total_ms += sample.total_ms;
        entry.db_ms += Math.min(sample.db_ms, sample.total_ms);
        entry.max_ms = Math.max(entry.max_ms, sample.total_ms);
        entry.histogram[latencyBucket(sample.total_ms)] += 1;
        entry.queries += sample.db_queries ?? 0;
        if ((sample.status ?? 0) >= 500) entry.errors += 1;
        else if ((sample.status ?? 0) >= 400) entry.client_errors += 1;
    }

    async flush() {
        if (!this.pending.size) return;
        const batch = [...this.pending.values()];
        this.pending = new Map();

        try {
            await this.metrics.collection.bulkWrite(
                batch.map((entry) => {
                    const inc: Record<string, number> = {
                        count: entry.count,
                        total_ms: entry.total_ms,
                        db_ms: entry.db_ms,
                        queries: entry.queries,
                        errors: entry.errors,
                        client_errors: entry.client_errors,
                    };
                    entry.histogram.forEach((value, index) => {
                        if (value) inc[`h.${index}`] = value;
                    });
                    return {
                        updateOne: {
                            filter: { hour: entry.hour, route: entry.route },
                            update: {
                                $inc: inc,
                                $max: { max_ms: entry.max_ms },
                                $setOnInsert: {
                                    bucket_at: new Date(`${entry.hour}:00:00Z`),
                                },
                            },
                            upsert: true,
                        },
                    };
                }),
                { ordered: false },
            );
        } catch (error) {
            const message =
                error instanceof Error ? error.message : 'metrics flush failed';
            this.logger.warn(message);
        }
    }

    async summary(fromHour: string, bucketKeyLength: 10 | 13) {
        await this.flush();
        const rows = await this.metrics
            .find({ hour: { $gte: fromHour } })
            .lean<StoredRow[]>();

        const byRoute = new Map<string, RouteTotals>();
        const byBucket = new Map<string, RouteTotals[]>();

        for (const row of rows) {
            const totals: RouteTotals = {
                route: row.route,
                count: row.count,
                total_ms: row.total_ms,
                db_ms: row.db_ms,
                max_ms: row.max_ms,
                histogram: histogramOf(row),
                queries: row.queries ?? 0,
                errors: row.errors ?? 0,
                client_errors: row.client_errors ?? 0,
            };

            const existing = byRoute.get(row.route);
            if (existing) {
                existing.count += totals.count;
                existing.total_ms += totals.total_ms;
                existing.db_ms += totals.db_ms;
                existing.max_ms = Math.max(existing.max_ms, totals.max_ms);
                existing.queries =
                    (existing.queries ?? 0) + (totals.queries ?? 0);
                existing.errors = (existing.errors ?? 0) + (totals.errors ?? 0);
                existing.client_errors =
                    (existing.client_errors ?? 0) + (totals.client_errors ?? 0);
                existing.histogram = existing.histogram.map(
                    (value, index) => value + totals.histogram[index],
                );
            } else {
                byRoute.set(row.route, totals);
            }

            const bucket = row.hour.slice(0, bucketKeyLength);
            const list = byBucket.get(bucket);
            if (list) list.push(totals);
            else byBucket.set(bucket, [totals]);
        }

        const routes = [...byRoute.values()];
        const slowest = routes
            .filter((route) => route.count >= 3)
            .map((route) => ({
                route: route.route,
                ...describeTimings([route]),
            }))
            .sort((a, b) => b.avg_ms - a.avg_ms)
            .slice(0, 8);

        const heaviest = routes
            .map((route) => ({
                route: route.route,
                ...describeLoad([route]),
                ...describeTimings([route]),
            }))
            .sort((a, b) => b.total_ms - a.total_ms)
            .slice(0, 8);
        const chatty = routes
            .filter((route) => route.count >= 3 && (route.queries ?? 0) > 0)
            .map((route) => ({
                route: route.route,
                ...describeLoad([route]),
                ...describeTimings([route]),
            }))
            .sort((a, b) => b.queries_avg - a.queries_avg)
            .slice(0, 8);
        const failing = routes
            .filter(
                (route) => (route.errors ?? 0) + (route.client_errors ?? 0) > 0,
            )
            .map((route) => ({
                route: route.route,
                requests: route.count,
                errors: route.errors ?? 0,
                client_errors: route.client_errors ?? 0,
            }))
            .sort(
                (a, b) =>
                    b.errors * 4 +
                    b.client_errors -
                    (a.errors * 4 + a.client_errors),
            )
            .slice(0, 8);

        const series = new Map<string, { avg_ms: number; db_ms: number }>();
        for (const [bucket, list] of byBucket) {
            const stats = describeTimings(list);
            series.set(bucket, {
                avg_ms: stats.avg_ms,
                db_ms: stats.db_avg_ms,
            });
        }

        return {
            overall: {
                ...describeTimings(routes),
                ...describeLoad(routes),
            },
            slowest,
            heaviest,
            chatty,
            failing,
            series,
        };
    }
}
