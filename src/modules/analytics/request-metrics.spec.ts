import {
    LATENCY_BUCKETS,
    describeTimings,
    isTrackedRoute,
    latencyBucket,
    percentileMs,
} from './request-metrics';

const histogramWith = (entries: Record<number, number>) => {
    const histogram = new Array<number>(LATENCY_BUCKETS).fill(0);
    for (const [index, value] of Object.entries(entries)) {
        histogram[Number(index)] = value;
    }
    return histogram;
};

describe('latencyBucket', () => {
    it('puts a duration into the first bucket that can hold it', () => {
        expect(latencyBucket(3)).toBe(0);
        expect(latencyBucket(25)).toBe(0);
        expect(latencyBucket(26)).toBe(1);
        expect(latencyBucket(60000)).toBe(LATENCY_BUCKETS - 1);
    });
});

describe('percentileMs', () => {
    it('returns zero for an empty histogram', () => {
        expect(percentileMs(histogramWith({}), 0.95, 0)).toBe(0);
    });

    it('reads the upper bound of the bucket holding the quantile', () => {
        const histogram = histogramWith({ 0: 90, 3: 10 });
        expect(percentileMs(histogram, 0.5, 300)).toBe(25);
        expect(percentileMs(histogram, 0.95, 300)).toBe(250);
    });

    it('never reports more than the slowest request seen', () => {
        expect(percentileMs(histogramWith({ 8: 4 }), 0.95, 7300)).toBe(7300);
        expect(percentileMs(histogramWith({ 3: 4 }), 0.95, 120)).toBe(120);
    });
});

describe('describeTimings', () => {
    it('combines routes into averages and a database share', () => {
        const stats = describeTimings([
            {
                route: 'GET /api/posts',
                count: 2,
                total_ms: 200,
                db_ms: 100,
                max_ms: 150,
                histogram: histogramWith({ 3: 2 }),
            },
            {
                route: 'GET /api/users',
                count: 2,
                total_ms: 40,
                db_ms: 20,
                max_ms: 30,
                histogram: histogramWith({ 1: 2 }),
            },
        ]);

        expect(stats.requests).toBe(4);
        expect(stats.avg_ms).toBe(60);
        expect(stats.db_avg_ms).toBe(30);
        expect(stats.db_share).toBe(0.5);
        expect(stats.max_ms).toBe(150);
    });

    it('is all zeros without traffic', () => {
        expect(describeTimings([])).toEqual({
            requests: 0,
            avg_ms: 0,
            p50_ms: 0,
            p95_ms: 0,
            max_ms: 0,
            db_avg_ms: 0,
            db_share: 0,
        });
    });
});

describe('isTrackedRoute', () => {
    it('leaves out health checks and the analytics endpoints themselves', () => {
        expect(isTrackedRoute('GET /health')).toBe(false);
        expect(isTrackedRoute('POST /api/analytics/visit')).toBe(false);
        expect(isTrackedRoute('GET /api/analytics/dashboard')).toBe(false);
        expect(isTrackedRoute('GET /api/posts/:id')).toBe(true);
    });
});
