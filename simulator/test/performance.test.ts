import { expect, it } from 'vitest';
import { cpus, platform, arch } from 'node:os';
import { writeFileSync } from 'node:fs';
import { Engine } from '../src/model/engine';
import { MetricsHistory } from '../src/metrics/metrics';

it.skipIf(!process.env.SIM_BENCHMARK)('retains bounded state through fifteen minutes at the maximum offered rate', () => {
  const engine = new Engine({ replicas: 8, capacity: 200, rate: 500, inFlightLimit: 256 });
  const history = new MetricsHistory();
  const snapshotMs: number[] = [];
  const maximum = { requests: 0, operations: 0, events: 0, traces: 0, scheduled: 0, completions: 0 };
  const started = performance.now();
  history.observe(engine.snapshot());
  for (let sample = 1; sample <= 4500; sample++) {
    if (sample === 1500) engine.command({ type: 'redis', incrMs: 100, publishMs: 100, rttMs: 2000 });
    if (sample === 3000) engine.command({ type: 'traffic', slowPercent: 100, slowSeconds: 10 });
    engine.runFor(0.2);
    const before = performance.now();
    const snapshot = engine.snapshot();
    history.observe(snapshot);
    snapshotMs.push(performance.now() - before);
    expect(snapshot.totals.offered).toBe(snapshot.totals.succeeded + snapshot.totals.failed + snapshot.requests.length);
    maximum.requests = Math.max(maximum.requests, snapshot.requests.length);
    maximum.operations = Math.max(maximum.operations, snapshot.redis.operations);
    maximum.events = Math.max(maximum.events, snapshot.events.length);
    maximum.traces = Math.max(maximum.traces, snapshot.traces.length);
    maximum.scheduled = Math.max(maximum.scheduled, snapshot.scheduledEvents);
    maximum.completions = Math.max(maximum.completions, snapshot.completions.length);
  }
  const elapsedMs = performance.now() - started;
  engine.command({ type: 'traffic', rate: 0 });
  engine.runFor(240);
  const settled = engine.snapshot();
  expect(settled.requests).toHaveLength(0);
  expect(settled.redis.operations).toBe(0);
  expect(settled.scheduledEvents).toBe(0);
  expect(settled.totals.offered).toBe(settled.totals.succeeded + settled.totals.failed);
  expect(maximum.requests).toBeLessThanOrEqual(2048);
  expect(maximum.operations).toBeLessThanOrEqual(2048);
  expect(maximum.events).toBeLessThanOrEqual(600);
  expect(maximum.traces).toBeLessThanOrEqual(101);
  expect(history.points.length).toBeLessThanOrEqual(301);
  snapshotMs.sort((a, b) => a - b);
  const report = { machine: cpus()[0]?.model, platform: `${platform()} ${arch()}`, node: process.version,
    simulatedSeconds: 900, wallSeconds: elapsedMs / 1000, snapshotAndMetricsP95Ms: snapshotMs[Math.ceil(snapshotMs.length * 0.95) - 1],
    maximum, finalOffered: settled.totals.offered, drained: true };
  if (process.env.SIM_BENCHMARK_REPORT) writeFileSync(process.env.SIM_BENCHMARK_REPORT, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}, 120_000);
