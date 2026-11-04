import { describe, expect, it } from 'vitest';
import { Engine } from '../src/model/engine';

function oneRoot(options: ConstructorParameters<typeof Engine>[0] = {}): Engine {
  const engine = new Engine({ replicas: 2, jitter: 0, rate: 1, redisRttMs: 0, ...options });
  engine.command({ type: 'traffic', rate: 0 }, 51);
  return engine;
}

describe('commit, acknowledgment, and deadline boundaries', () => {
  it('can commit twice after a backend loses its connection, but completes the client once', () => {
    const engine = oneRoot();
    engine.command({ type: 'stop', backend: 1 }, 51);
    engine.runFor(1.2);
    const s = engine.snapshot();
    expect(s.totals.offered).toBe(1);
    expect(s.totals.succeeded).toBe(1);
    expect(s.totals.attempts).toBe(2);
    expect(s.totals.localEntries).toBe(2);
    expect(s.totals.globalCount).toBe(2);
    expect(s.traces[0]!.events.filter(e => e.kind === 'terminal')).toHaveLength(1);
  });

  it('a Redis outage at the exact INCR commit timestamp cancels the uncommitted command', () => {
    const engine = oneRoot({ redisIncrMs: 3 });
    engine.command({ type: 'redis', online: false }, 51);
    engine.runFor(1.2);
    const s = engine.snapshot();
    expect(s.totals.localEntries).toBe(1);
    expect(s.totals.globalCount).toBe(0);
    expect(s.traces[0]!.outcome).toBe('http_500');
    engine.command({ type: 'redis', online: true });
    engine.runFor(1);
    expect(engine.snapshot().totals.globalCount).toBe(0);
    expect(engine.snapshot().redis.operations).toBe(0);
  });

  it('PUBLISH failure does not undo a committed INCR or change the successful response', () => {
    const engine = oneRoot();
    engine.command({ type: 'redis', online: false }, 51);
    engine.runFor(1.2);
    const s = engine.snapshot();
    expect(s.totals.globalCount).toBe(1);
    expect(s.totals.publishFailures).toBe(1);
    expect(s.totals.succeeded).toBe(1);
  });

  it('allows an already traveling Redis acknowledgment to arrive during an outage', () => {
    const engine = oneRoot({ redisRttMs: 40 });
    engine.command({ type: 'redis', online: false }, 52);
    engine.runFor(1.2);
    const s = engine.snapshot();
    expect(s.totals.globalCount).toBe(1);
    expect(s.totals.succeeded).toBe(1);
    expect(s.traces[0]!.events.some(e => e.kind === 'redis-ack' && e.at > 1_040_000)).toBe(true);
  });

  it('an acknowledgment delivered exactly at the PUBLISH deadline wins; a late one fails', () => {
    for (const publishMs of [4, 5]) {
      const engine = oneRoot({ redisRttMs: 496, redisPublishMs: publishMs });
      engine.runFor(3);
      const s = engine.snapshot();
      expect(s.totals.succeeded).toBe(1);
      expect(s.totals.publishFailures).toBe(publishMs === 4 ? 0 : 1);
      expect(s.redis.operations).toBe(0);
      expect(s.scheduledEvents).toBe(0);
    }
  });

  it('keeps accepted Redis work after a caller disconnects, without resurrecting old CPU work', () => {
    const engine = oneRoot({ redisIncrMs: 100 });
    engine.command({ type: 'restart', backend: 1 }, 51);
    engine.runFor(1.04);
    expect(engine.snapshot().redis.detached).toBe(1);
    engine.runFor(1);
    const s = engine.snapshot();
    expect(s.totals.globalCount).toBe(2);
    expect(s.totals.succeeded).toBe(1);
    expect(s.backends[0]!.localCount).toBe(0);
    expect(s.backends[0]!.incarnation).toBe(2);
    expect(s.redis.operations).toBe(0);
    expect(s.scheduledEvents).toBe(0);
  });

  it('enforces the twelve-second drain budget when admitted work exceeds it', () => {
    const engine = new Engine({ replicas: 1, capacity: 5, rate: 500, inFlightLimit: 256, jitter: 0 });
    engine.runFor(0.5);
    engine.command({ type: 'drain', backend: 1 });
    engine.command({ type: 'traffic', rate: 0 });
    engine.runFor(12.04);
    const s = engine.snapshot();
    expect(s.backends[0]!.state).toBe('stopped');
    expect(s.requests).toHaveLength(0);
    expect(s.totals.failed).toBeGreaterThan(0);
    expect(s.events.some(e => e.kind === 'attempt-failed' && e.message.includes('connection lost'))).toBe(true);
    expect(s.totals.offered).toBe(s.totals.succeeded + s.totals.failed);
  });
});
