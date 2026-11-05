import { expect, it } from 'vitest';
import { Engine } from '../src/model/engine';
import { Clock } from '../src/model/clock';
import { RunRecorder, compareRuns } from '../src/metrics/comparison';
import type { Config } from '../src/model/config';
import type { Command, RecordedCommand } from '../src/model/types';

function record(config: Partial<Config> = {}, commands: { tick: number; command: Command }[] = []) {
  const engine = new Engine(config);
  engine.replay(commands);
  const recorder = new RunRecorder();
  recorder.observe(engine.snapshot());
  for (let i = 0; i < 100; i++) { engine.runFor(0.2); recorder.observe(engine.snapshot()); }
  return recorder.result!;
}

it('compares identical complete runs with zero deltas', () => {
  const baseline = record();
  const candidate = record();
  expect(baseline.invalidReason).toBeUndefined();
  const comparison = compareRuns(baseline, candidate);
  expect(comparison.comparable).toBe(true);
  expect(Object.values(comparison.delta!).every(value => value === 0)).toBe(true);
  expect(comparison.changes).toHaveLength(0);
  expect(baseline.values.completed).toBeGreaterThan(400);
});

it('isolates a capacity change while preserving the exact offered stream', () => {
  const baseline = record({ replicas: 1, rate: 70, capacity: 50 });
  const candidate = record({ replicas: 1, rate: 70, capacity: 100 });
  const comparison = compareRuns(baseline, candidate);
  expect(comparison.comparable).toBe(true);
  expect(comparison.changes).toEqual(['capacity: 50 → 100']);
  expect(comparison.delta!.successRate).toBeGreaterThan(15);
  expect(comparison.delta!.averageQueue).toBeLessThan(0);
});

it('reports reordered interventions at the same tick when their outcomes differ', () => {
  const commands = (values: number[]) => values.map(value => ({
    tick: 50, command: { type: 'capacity' as const, backend: 1, value },
  }));
  const baseline = record({ replicas: 1, rate: 70, jitter: 0 }, commands([100, 20]));
  const candidate = record({ replicas: 1, rate: 70, jitter: 0 }, commands([20, 100]));
  const comparison = compareRuns(baseline, candidate);
  expect(comparison.comparable).toBe(true);
  expect(comparison.delta!.successRate).toBeGreaterThan(40);
  expect(comparison.changes).toHaveLength(1);
  expect(comparison.changes[0]).toContain('1.00 s');
  expect(comparison.changes[0]).toContain('execution order');
});

it('compares execution order rather than the order future commands were recorded', () => {
  const commands = [
    { tick: 50, command: { type: 'capacity' as const, backend: 1, value: 100 } },
    { tick: 100, command: { type: 'capacity' as const, backend: 1, value: 20 } },
  ];
  const comparison = compareRuns(record({}, commands), record({}, [...commands].reverse()));
  expect(comparison.comparable).toBe(true);
  expect(comparison.changes).toEqual([]);
  expect(Object.values(comparison.delta!).every(value => value === 0)).toBe(true);
});

it('rejects incomplete windows, mismatched seeds, traffic, versions, and observation windows', () => {
  const engine = new Engine();
  const recorder = new RunRecorder();
  recorder.observe(engine.snapshot()); engine.runFor(4); recorder.observe(engine.snapshot());
  expect(recorder.result).toBeUndefined();
  const baseline = record();
  for (const candidate of [record({ seed: 2 }), record({ rate: 31 }), { ...baseline, version: 'other' }, { ...baseline, end: 19_000_000 }]) {
    expect(compareRuns(baseline, candidate).comparable).toBe(false);
  }
});

it('handles an empty completion cohort without invented latency or percentage changes', () => {
  const baseline = record({ rate: 0 });
  const comparison = compareRuns(baseline, record({ rate: 0 }));
  expect(comparison.comparable).toBe(true);
  expect(comparison.delta!.averageMs).toBeNull();
  expect(comparison.delta!.p95Ms).toBeNull();
  expect(baseline.values.completed).toBe(0);
});

it('replays common interventions, including targets created later', () => {
  const commands: RecordedCommand[] = [
    { tick: 50, command: { type: 'add' } },
    { tick: 100, command: { type: 'capacity', backend: 4, value: 100 } },
    { tick: 200, command: { type: 'stop', backend: 2 } },
  ];
  const baseline = record({}, commands);
  expect(baseline.commands.every(c => c.applied)).toBe(true);
  const replay = record(baseline.initialConfig, baseline.commands);
  expect(compareRuns(baseline, replay).delta!.globalIncrements).toBe(0);
  expect(compareRuns(baseline, replay).changes).toEqual([]);
});

it('rejects invalid intervention targets rather than comparing a silently different run', () => {
  const bad = record({}, [{ tick: 50, command: { type: 'stop', backend: 99 } }]);
  expect(bad.invalidReason).toMatch(/invalid state or component/);
  expect(compareRuns(record(), bad).comparable).toBe(false);
});

it('stops consuming frames when an observation completion pauses playback', () => {
  let ticks = 0;
  const clock = new Clock(() => { ticks++; if (ticks === 3) clock.pause(); });
  clock.resume(); clock.consume(2000);
  expect(ticks).toBe(3);
  expect(clock.paused).toBe(true);
});

it('remembers a recording gap even if the final boundary itself is present', () => {
  const engine = new Engine({ rate: 0 });
  const recorder = new RunRecorder();
  recorder.observe(engine.snapshot());
  engine.runFor(5); recorder.observe(engine.snapshot());
  engine.runFor(6); recorder.observe(engine.snapshot());
  for (let i = 0; i < 45; i++) { engine.runFor(0.2); recorder.observe(engine.snapshot()); }
  expect(recorder.result!.invalidReason).toMatch(/complete 5–20/);
});
