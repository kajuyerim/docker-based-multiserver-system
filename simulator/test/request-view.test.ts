import { describe, expect, it } from 'vitest';
import { Engine } from '../src/model/engine';
import { TraceCursor, backgroundEvents, eventLocation, metricTarget, pressure, requestView } from '../src/view/request-view';
import type { Snapshot } from '../src/model/types';

function oneRequest(config: ConstructorParameters<typeof Engine>[0] = {}): Engine {
  const engine = new Engine({ rate: 1, jitter: 0, replicas: 2, redisRttMs: 0, ...config });
  engine.command({ type: 'traffic', rate: 0 }, 51);
  return engine;
}

describe('recorded request evidence', () => {
  it('separates handler entry, atomic INCR, best-effort PUBLISH, and delivered success', () => {
    const engine = oneRequest(); engine.runFor(1.2);
    const snapshot = engine.snapshot(), trace = snapshot.traces[0]!;
    const views = trace.events.map(event => requestView(trace, snapshot, event.sequence)!);
    expect(views.find(v => v.event.kind === 'handler')!.explanation).toContain('local counter advances');
    const incr = views.find(v => v.event.kind === 'redis-commit' && v.event.redisCommand === 'incr')!;
    expect(incr.title).toBe('INCR updated in memory');
    expect(incr.explanation).toContain('produced 1'); expect(incr.explanation).toContain('not today’s global count');
    expect(incr.component).toBe('redis'); expect(incr.identity).toContain('app1 · incarnation 1');
    const publish = views.find(v => v.event.kind === 'redis-commit' && v.event.redisCommand === 'publish')!;
    expect(publish.explanation).toContain('does not increment'); expect(publish.explanation).toContain('delivery to a browser');
    expect(views.at(-1)!.title).toBe('Client success'); expect(views.at(-1)!.component).toBe('clients');
    expect(views.at(-1)!.path).toContainEqual(['app1', 'redis']);
    expect(snapshot.totals.globalCount).toBe(1);
  });

  it('explains /slow without inventing CPU occupancy or Redis work', () => {
    const engine = oneRequest({ slowPercent: 100, slowSeconds: 2 }); engine.runFor(1.5);
    const snapshot = engine.snapshot(), trace = snapshot.traces[0]!;
    const event = trace.events.find(e => e.kind === 'sleep')!;
    expect(requestView(trace, snapshot, event.sequence)!.title).toBe('Sleeping · CPU released');
    expect(pressure(snapshot, 'app1')).toEqual([['CPU queued', 0], ['CPU active', 0], ['Sleeping', 1], ['Redis wait', 0]]);
    expect(trace.events.some(e => e.redisCommand)).toBe(false);
    expect(snapshot.totals.globalCount).toBe(0); expect(snapshot.totals.localEntries).toBe(0);
    engine.runFor(2); expect(engine.snapshot().traces[0]!.outcome).toBe('success');
  });

  it('keeps retry attempt identities inside one offered request and preserves pre-failure INCR evidence', () => {
    for (const retry of [true, false]) {
      const engine = oneRequest({ retry }); engine.command({ type: 'stop', backend: 1 }, 51); engine.runFor(1.3);
      const snapshot = engine.snapshot(), trace = snapshot.traces[0]!;
      const commit = trace.events.find(e => e.kind === 'redis-commit' && e.redisCommand === 'incr')!;
      const failure = trace.events.find(e => e.kind === 'attempt-failed')!;
      expect(commit.at).toBeLessThan(failure.at);
      const view = requestView(trace, snapshot, commit.sequence)!;
      expect(view.event.redisResult).toBe(1); expect(view.component).toBe('redis');
      expect(snapshot.totals.offered).toBe(1);
      expect(new Set(trace.events.filter(e => e.kind === 'routing').map(e => e.attempt)).size).toBe(retry ? 2 : 1);
      const terminal = trace.events.find(e => e.kind === 'terminal')!;
      expect(requestView(trace, snapshot, terminal.sequence)!.title).toBe(retry ? 'Client success' : 'Client failure');
      if (!retry) {
        expect(requestView(trace, snapshot)!.title).toBe('PUBLISH executed');
        expect(trace.outcome).toBe('proxy_failure');
      }
      if (retry) expect(requestView(trace, snapshot, trace.events.find(e => e.kind === 'retry')!.sequence)!.explanation).toContain('not an offered client request');
    }
  });

  it('does not place an old or removed process on a different current backend', () => {
    const engine = oneRequest({ redisIncrMs: 100 }); engine.command({ type: 'restart', backend: 1 }, 51); engine.runFor(1.4);
    const snapshot = engine.snapshot(), trace = snapshot.traces[0]!;
    const original = trace.events.find(e => e.kind === 'handler')!;
    const view = requestView(trace, snapshot, original.sequence)!;
    expect(view.component).toBeUndefined(); expect(view.locationNote).toContain('incarnation 2');
    expect(view.identity).toContain('incarnation 1'); expect(view.path.some(s => s.includes('app1'))).toBe(false);
    const removed: Snapshot = { ...snapshot, backends: snapshot.backends.filter(b => b.id !== 1) };
    expect(requestView(trace, removed, original.sequence)!.locationNote).toContain('removed');
    expect(eventLocation(original, removed).component).toBeUndefined();
    const commit = trace.events.find(e => e.kind === 'redis-commit' && e.backend === 1)!;
    expect(requestView(trace, removed, commit.sequence)!.component).toBe('redis');
  });

  it('retains the selected path independently of a saturated background buffer and keeps a fixed historical cursor', () => {
    const engine = new Engine({ replicas: 8, capacity: 200, rate: 500, jitter: 0 });
    engine.runFor(0.02); engine.pinTrace(1);
    const cursor = new TraceCursor(); cursor.select(1); cursor.observe(engine.snapshot()); cursor.move(-100);
    const first = cursor.sequence;
    engine.runFor(3); const snapshot = engine.snapshot(); cursor.observe(snapshot);
    expect(snapshot.events).toHaveLength(600); expect(snapshot.events.some(e => e.request === 1)).toBe(false);
    expect(snapshot.traces).toHaveLength(101); expect(cursor.sequence).toBe(first);
    expect(cursor.view(snapshot)!.title).toBe('Client request offered');
    cursor.sequence = undefined;
    expect(cursor.view(snapshot)!.path).toContainEqual(['app1', 'redis']);
    expect(cursor.view(snapshot)!.event.kind).toBe('terminal');
    const totals = snapshot.totals;
    cursor.move(-1); cursor.move(1); expect(snapshot.totals).toBe(totals);
    cursor.select(999999); cursor.observe(snapshot); expect(cursor.view(snapshot)).toBeUndefined();
  });

  it('caps the background at 200 transport markers without consuming the reserved history path', () => {
    const engine = oneRequest(); engine.runFor(1.2); engine.pinTrace(1);
    engine.command({ type: 'traffic', rate: 500, slowPercent: 100 }); engine.runFor(3);
    const snapshot = engine.snapshot(), trace = snapshot.traces.find(t => t.id === 1)!;
    expect(backgroundEvents(snapshot, snapshot.now, 1)).toHaveLength(200);
    expect(backgroundEvents(snapshot, snapshot.now, 1).every(e => e.request !== 1)).toBe(true);
    expect(requestView(trace, snapshot)!.path).toContainEqual(['app1', 'redis']);
    expect(backgroundEvents(snapshot, snapshot.now + 400_000, 1)).toHaveLength(0);
  });
});

describe('current pressure and model independence', () => {
  it('keeps RTT outside Redis execution and displays actual execution and queue recovery', () => {
    const engine = oneRequest({ redisRttMs: 1000, redisIncrMs: 100 }); engine.runFor(1.2);
    expect(pressure(engine.snapshot(), 'redis')).toEqual([['Queued', 0], ['Executing', 0], ['In transport', 1], ['Detached', 0]]);
    expect(pressure(engine.snapshot(), 'app1')).toEqual([['CPU queued', 0], ['CPU active', 0], ['Sleeping', 0], ['Redis wait', 1]]);
    engine.runFor(0.4);
    expect(pressure(engine.snapshot(), 'redis')).toEqual([['Queued', 0], ['Executing', 1], ['In transport', 0], ['Detached', 0]]);
    const overloaded = new Engine({ replicas: 1, capacity: 5, rate: 50, jitter: 0 }); overloaded.runFor(0.5);
    expect(pressure(overloaded.snapshot(), 'app1')[0]![1]).toBeGreaterThan(10);
    expect(metricTarget('queue', overloaded.snapshot()).component).toBe('app1');
    overloaded.command({ type: 'traffic', rate: 0 }); overloaded.command({ type: 'capacity', backend: 1, value: 200 }); overloaded.runFor(3);
    expect(pressure(overloaded.snapshot(), 'app1').every(([, count]) => count === 0)).toBe(true);
    expect(metricTarget('global', overloaded.snapshot()).explanation).toContain('not a delivered-response');
  });

  it('cannot change seeded outcomes, timing, workload, commands or resource accounting through inspection', () => {
    const baseline = new Engine({ rate: 100, replicas: 3 }), inspected = new Engine({ rate: 100, replicas: 3 });
    for (const engine of [baseline, inspected]) {
      engine.command({ type: 'stop', backend: 1 }, 75);
      engine.command({ type: 'redis', rttMs: 1000 }, 120);
      engine.command({ type: 'traffic', slowPercent: 50 }, 180);
    }
    const cursor = new TraceCursor(); cursor.select(1);
    for (let tick = 0; tick < 400; tick++) {
      baseline.step(); inspected.step(); inspected.pinTrace(1);
      const snapshot = inspected.snapshot(); cursor.observe(snapshot); cursor.move(tick % 2 ? 1 : -1);
      cursor.view(snapshot); pressure(snapshot, 'redis'); metricTarget('cpu', snapshot);
    }
    const { traces: _baseTraces, ...base } = baseline.snapshot();
    const { traces: _inspectedTraces, ...actual } = inspected.snapshot();
    expect(actual).toEqual(base);
  });
});
