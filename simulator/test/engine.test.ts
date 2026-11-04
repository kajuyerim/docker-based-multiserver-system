import { describe, expect, it } from 'vitest';
import { Engine } from '../src/model/engine';
import { LIMITS } from '../src/model/config';
import type { Snapshot } from '../src/model/types';

function conserved(s: Snapshot): void {
  expect(s.totals.offered).toBe(s.totals.succeeded + s.totals.failed + s.requests.length);
  expect(s.requests.length).toBeLessThanOrEqual(LIMITS.requests);
  expect(s.redis.operations).toBeLessThanOrEqual(LIMITS.redisOperations);
  for (const b of s.backends) expect(b.inFlight).toBeLessThanOrEqual(b.inFlightLimit);
}

function settle(engine: Engine, seconds = 16): Snapshot {
  engine.command({ type: 'traffic', rate: 0 });
  engine.runFor(seconds);
  const s = engine.snapshot();
  conserved(s);
  expect(s.requests).toHaveLength(0);
  return s;
}

describe('healthy request paths', () => {
  it('distributes requests evenly and increments both counters only for roots', () => {
    const engine = new Engine({ jitter: 0, rate: 30 });
    engine.runFor(3);
    const s = settle(engine);
    expect(s.totals.offered).toBe(90);
    expect(s.totals.succeeded).toBe(90);
    expect(s.totals.globalCount).toBe(90);
    expect(s.backends.map(b => b.localCount)).toEqual([30, 30, 30]);
    expect(s.totals.failed).toBe(0);
    expect(s.redis.operations).toBe(0);
    expect(s.scheduledEvents).toBe(0);
  });

  it('releases CPU while sleeping and never uses Redis for slow requests', () => {
    const engine = new Engine({ replicas: 1, jitter: 0, rate: 20, slowPercent: 100, slowSeconds: 2 });
    engine.runFor(1);
    const early = engine.snapshot();
    expect(early.backends[0]!.sleeping).toBeGreaterThan(15);
    expect(early.backends[0]!.busyUs / early.now).toBeLessThan(0.05);
    expect(early.totals.globalCount).toBe(0);
    const s = settle(engine);
    expect(s.totals.succeeded).toBe(20);
    expect(s.totals.localEntries).toBe(0);
  });

  it('exposes the complete semantic lifecycle in a persistent bounded trace', () => {
    const engine = new Engine({ replicas: 1, rate: 1, jitter: 0 });
    engine.runFor(1.2);
    const trace = engine.snapshot().traces[0]!;
    expect(trace.outcome).toBe('success');
    expect(trace.events.map(e => e.kind)).toEqual([
      'arrival', 'routing', 'handler', 'queue', 'processing', 'redis-send', 'redis-queue',
      'redis-execute', 'redis-commit', 'redis-ack', 'redis-send', 'redis-queue', 'redis-execute',
      'redis-commit', 'redis-ack', 'queue', 'processing', 'response', 'terminal',
    ]);
  });

  it('uses immutable snapshots detached from live state', () => {
    const engine = new Engine();
    engine.runFor(1);
    const first = engine.snapshot();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.backends[0])).toBe(true);
    expect(() => { (first.backends[0] as { localCount: number }).localCount = 100; }).toThrow();
    const encoded = JSON.stringify(first);
    engine.runFor(1);
    expect(JSON.stringify(first)).toBe(encoded);
    expect(engine.snapshot().totals.globalCount).toBeGreaterThan(first.totals.globalCount);
  });
});

describe('capacity and saturation', () => {
  it('builds CPU queues under overload, and scale-out clears them', () => {
    const engine = new Engine({ replicas: 1, rate: 120, jitter: 0 });
    engine.runFor(1);
    expect(engine.snapshot().backends[0]!.cpuQueue).toBeGreaterThan(30);
    engine.command({ type: 'add' });
    engine.command({ type: 'add' });
    engine.runFor(8);
    const s = engine.snapshot();
    conserved(s);
    expect(s.backends.map(b => b.cpuQueue).reduce((a, b) => a + b, 0)).toBeLessThan(10);
    expect(s.completions.filter(c => c.outcome === 'success').length / 5).toBeGreaterThan(110);
  });

  it('labels synthetic backend admission failure without retry or passive ejection', () => {
    const engine = new Engine({ replicas: 1, rate: 100, jitter: 0, inFlightLimit: 2, slowPercent: 100, slowSeconds: 10 });
    engine.runFor(1);
    const s = engine.snapshot();
    conserved(s);
    expect(s.totals.rejected).toBeGreaterThan(90);
    expect(s.totals.retried).toBe(0);
    expect(s.backends[0]!.excludedUntil).toBe(0);
  });

  it('models shared Redis capacity separately from overlapping transport', () => {
    const bottleneck = new Engine({ replicas: 8, rate: 250, redisIncrMs: 6, redisPublishMs: 4, jitter: 0 });
    bottleneck.runFor(4);
    const s = bottleneck.snapshot();
    conserved(s);
    expect(s.redis.queue).toBeGreaterThan(100);
    expect(s.redis.busyUs / s.now).toBeGreaterThan(0.9);
    const network = new Engine({ replicas: 8, rate: 250, redisRttMs: 100, jitter: 0 });
    network.runFor(8);
    const n = network.snapshot();
    expect(n.completions.filter(c => c.outcome === 'success').length / 5).toBeGreaterThan(240);
    expect(n.redis.busyUs / n.now).toBeLessThan(0.8);
  });

  it('accounts already performed CPU work when capacity changes, without duplicate completion', () => {
    const engine = new Engine({ replicas: 1, rate: 1, capacity: 5, jitter: 0, redisRttMs: 0 });
    engine.runFor(1.08);
    engine.command({ type: 'capacity', backend: 1, value: 200 });
    engine.runFor(0.12);
    const s = engine.snapshot();
    expect(s.totals.succeeded).toBe(1);
    expect(s.totals.globalCount).toBe(1);
    expect(s.completions[0]!.latencyUs).toBeLessThan(120_000);
    settle(engine);
    expect(engine.snapshot().totals.succeeded).toBe(1);
  });
});

describe('failures and process identity', () => {
  it('discovers a stopped process passively and retries within one logical request', () => {
    for (const retry of [true, false]) {
      const engine = new Engine({ jitter: 0, rate: 30, retry });
      engine.command({ type: 'stop', backend: 2 });
      engine.runFor(1);
      const s = settle(engine);
      expect(s.backends[1]!.excludedUntil).toBeGreaterThan(0);
      expect(s.totals.failed).toBe(retry ? 0 : 1);
      expect(s.totals.succeeded).toBe(retry ? 30 : 29);
      expect(s.totals.retried).toBe(retry ? 1 : 0);
    }
  });

  it('exhausts three total attempts, then fails fast with no eligible backend', () => {
    const engine = new Engine({ rate: 10, jitter: 0 });
    for (const backend of [1, 2, 3]) engine.command({ type: 'stop', backend });
    engine.runFor(1);
    const s = settle(engine);
    expect(s.totals.failed).toBe(10);
    expect(s.totals.attempts).toBe(3);
    expect(s.traces[0]!.events.filter(e => e.kind === 'routing')).toHaveLength(3);
  });

  it('ignores passive exclusion for a single configured upstream', () => {
    const engine = new Engine({ replicas: 1, rate: 10, jitter: 0 });
    engine.command({ type: 'stop', backend: 1 });
    engine.runFor(1);
    const s = settle(engine);
    expect(s.totals.attempts).toBe(10);
    expect(s.totals.failed).toBe(10);
  });

  it('returns Redis-error HTTP 500 without proxy retry while advancing local only', () => {
    const engine = new Engine({ rate: 10, jitter: 0, redisOnline: false });
    engine.runFor(1);
    const s = settle(engine);
    expect(s.totals.localEntries).toBe(10);
    expect(s.totals.globalCount).toBe(0);
    expect(s.totals.attempts).toBe(10);
    expect(s.totals.retried).toBe(0);
    expect(s.traces.every(t => t.outcome === 'http_500')).toBe(true);
  });

  it('resets local process memory on restart and retains shared state', () => {
    const engine = new Engine({ replicas: 1, jitter: 0, rate: 10 });
    engine.runFor(1);
    engine.command({ type: 'traffic', rate: 0 });
    engine.runFor(0.2);
    const globalBefore = engine.snapshot().totals.globalCount;
    engine.command({ type: 'restart', backend: 1 });
    engine.runFor(0.6);
    const s = engine.snapshot();
    expect(s.backends[0]!.state).toBe('running');
    expect(s.backends[0]!.incarnation).toBe(2);
    expect(s.backends[0]!.localCount).toBe(0);
    expect(s.totals.globalCount).toBe(globalBefore);
    expect(s.totals.localEntries).toBe(globalBefore);
  });

  it('drains admitted sleep without accepting new work or losing requests', () => {
    const engine = new Engine({ rate: 30, jitter: 0, slowPercent: 100, slowSeconds: 2 });
    engine.runFor(1);
    engine.command({ type: 'drain', backend: 2 });
    engine.runFor(0.1);
    const admissions = engine.snapshot().backends[1]!.attempts;
    expect(engine.snapshot().backends[1]!.state).toBe('draining');
    engine.runFor(3);
    const s = settle(engine);
    expect(s.backends[1]!.state).toBe('stopped');
    expect(s.backends[1]!.attempts).toBe(admissions);
    expect(s.totals.failed).toBe(0);
    expect(s.totals.succeeded).toBe(s.totals.offered);
  });

  it('removes through drain and preserves conservation during removal and repeat clicks', () => {
    const engine = new Engine({ rate: 30, jitter: 0, slowPercent: 100, slowSeconds: 1 });
    engine.runFor(0.5);
    engine.command({ type: 'remove', backend: 2 });
    engine.command({ type: 'remove', backend: 2 });
    engine.runFor(0.02);
    expect(engine.snapshot().events.some(e => e.kind === 'command-rejected')).toBe(true);
    engine.runFor(1.98);
    const s = settle(engine);
    expect(s.backends.map(b => b.id)).toEqual([1, 3]);
    expect(s.totals.failed).toBe(0);
  });
});

describe('replay and bounds', () => {
  it('replays an identical seed and command schedule exactly', () => {
    const run = (seed: number) => {
      const engine = new Engine({ seed, slowPercent: 20, rate: 60 });
      engine.command({ type: 'stop', backend: 2 }, 50);
      engine.command({ type: 'capacity', backend: 1, value: 80 }, 90);
      engine.command({ type: 'restart', backend: 2 }, 100);
      engine.runFor(4);
      return engine.snapshot();
    };
    expect(run(476)).toEqual(run(476));
    expect(run(477).workloadHash).not.toBe(run(476).workloadHash);
  });

  it('keeps the offered workload identical when retry or capacity changes', () => {
    const first = new Engine({ rate: 100, slowPercent: 30 });
    const second = new Engine({ rate: 100, slowPercent: 30, capacity: 20, retry: false });
    first.command({ type: 'stop', backend: 2 }, 50);
    second.command({ type: 'stop', backend: 2 }, 50);
    first.runFor(3); second.runFor(3);
    expect(first.snapshot().workloadHash).toBe(second.snapshot().workloadHash);
    expect(first.snapshot().totals.offered).toBe(second.snapshot().totals.offered);
  });

  it('enforces finite queues and event history through sustained overload and stop/restart churn', () => {
    const engine = new Engine({ replicas: 8, rate: 500, redisIncrMs: 100, redisPublishMs: 100, inFlightLimit: 256 });
    for (let cycle = 0; cycle < 30; cycle++) {
      engine.runFor(1);
      engine.command({ type: cycle % 2 ? 'restart' : 'stop', backend: 1 });
      const s = engine.snapshot();
      conserved(s);
      expect(s.events.length).toBeLessThanOrEqual(LIMITS.events);
      expect(s.traces.length).toBeLessThanOrEqual(LIMITS.traces);
      expect(s.scheduledEvents).toBeLessThan(15_000);
    }
    settle(engine, 30);
  });
});
