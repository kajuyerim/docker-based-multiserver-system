import { expect, it } from 'vitest';
import { Engine } from '../src/model/engine';
import { latency, measure, MetricsHistory } from '../src/metrics/metrics';

it('calculates exact nearest-rank p95 and handles empty samples', () => {
  expect(latency([])).toEqual({ average: null, p95: null });
  expect(latency([1])).toEqual({ average: 1, p95: 1 });
  expect(latency(Array.from({ length: 100 }, (_, i) => i + 1))).toEqual({ average: 50.5, p95: 95 });
  expect(latency([10, 5, 20])).toEqual({ average: 35 / 3, p95: 20 });
});

it('uses terminal client outcomes for throughput and errors, including retries once', () => {
  const engine = new Engine({ rate: 30, jitter: 0 });
  const start = engine.snapshot();
  engine.command({ type: 'stop', backend: 2 });
  engine.runFor(2);
  const end = engine.snapshot();
  const m = measure(end, start);
  expect(m.offeredRate).toBe(30);
  expect(m.successRate).toBe(end.totals.succeeded / 2);
  expect(m.errorFraction).toBe(0);
  expect(m.samples).toBe(end.totals.succeeded);
  expect(m.pending).toBe(end.requests.length);
  expect(m.oldestMs).toBeGreaterThan(0);
  expect(end.totals.attempts).toBeGreaterThan(end.totals.offered);
});

it('keeps empty latency and error cohorts explicit, even with pending requests', () => {
  const engine = new Engine({ slowPercent: 100, slowSeconds: 10 });
  const start = engine.snapshot();
  engine.runFor(1);
  const m = measure(engine.snapshot(), start);
  expect(m.samples).toBe(0);
  expect(m.p95Ms).toBeNull();
  expect(m.errorFraction).toBeNull();
  expect(m.pending).toBeGreaterThan(0);
  expect(m.oldestMs).toBeGreaterThan(900);
});

it('integrates CPU and Redis occupation independently, not from completed latency', () => {
  const engine = new Engine({ rate: 30, jitter: 0, redisRttMs: 100 });
  const start = engine.snapshot();
  engine.runFor(5);
  const m = measure(engine.snapshot(), start);
  expect(m.cpuUtilization).toBeCloseTo(0.2, 1);
  expect(m.redisUtilization).toBeCloseTo(0.09, 1);
  expect(m.averageMs).toBeGreaterThan(200);
});

it('bounds chart history at one minute and uses a five-second rolling cohort', () => {
  const engine = new Engine({ rate: 10, jitter: 0 });
  const history = new MetricsHistory();
  history.observe(engine.snapshot());
  for (let i = 0; i < 400; i++) { engine.runFor(0.2); history.observe(engine.snapshot()); }
  expect(history.points).toHaveLength(301);
  expect(history.points.at(-1)!.metrics.windowSeconds).toBe(5);
  expect(history.points.at(-1)!.metrics.samples).toBe(50);
  expect(history.points.at(-1)!.metrics.successRate).toBe(10);
});
