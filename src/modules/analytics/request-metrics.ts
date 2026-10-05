export const LATENCY_BOUNDS_MS = [25, 50, 100, 250, 500, 1000, 2500, 5000];
export const LATENCY_BUCKETS = LATENCY_BOUNDS_MS.length + 1;

const IGNORED_ROUTES = [/^[A-Z]+ \/health/, /^[A-Z]+ \/api\/analytics\//];

export function isTrackedRoute(route: string) {
    return !IGNORED_ROUTES.some((pattern) => pattern.test(route));
}

export function latencyBucket(ms: number) {
    const index = LATENCY_BOUNDS_MS.findIndex((bound) => ms <= bound);
    return index === -1 ? LATENCY_BOUNDS_MS.length : index;
}

export function percentileMs(
    histogram: number[],
    quantile: number,
    maxMs: number,
) {
    const total = histogram.reduce((sum, value) => sum + value, 0);
    if (!total) return 0;
    const target = Math.ceil(total * quantile);
    let seen = 0;
    for (let index = 0; index < histogram.length; index += 1) {
        seen += histogram[index];
        if (seen >= target) {
            const bound = LATENCY_BOUNDS_MS[index];
            return bound === undefined ? maxMs : Math.min(bound, maxMs);
        }
    }
    return maxMs;
}

export type RouteTotals = {
    route: string;
    count: number;
    total_ms: number;
    db_ms: number;
    max_ms: number;
    histogram: number[];
};

export function mergeHistograms(items: number[][]) {
    const merged = new Array<number>(LATENCY_BUCKETS).fill(0);
    for (const histogram of items) {
        for (let index = 0; index < LATENCY_BUCKETS; index += 1) {
            merged[index] += histogram[index] || 0;
        }
    }
    return merged;
}

const round = (value: number) => Math.round(value * 10) / 10;

export function describeTimings(rows: RouteTotals[]) {
    const count = rows.reduce((sum, row) => sum + row.count, 0);
    const total = rows.reduce((sum, row) => sum + row.total_ms, 0);
    const db = rows.reduce((sum, row) => sum + row.db_ms, 0);
    const max = rows.reduce((peak, row) => Math.max(peak, row.max_ms), 0);
    const histogram = mergeHistograms(rows.map((row) => row.histogram));

    return {
        requests: count,
        avg_ms: count ? round(total / count) : 0,
        p50_ms: round(percentileMs(histogram, 0.5, max)),
        p95_ms: round(percentileMs(histogram, 0.95, max)),
        max_ms: round(max),
        db_avg_ms: count ? round(db / count) : 0,
        db_share: total ? Math.min(1, db / total) : 0,
    };
}
