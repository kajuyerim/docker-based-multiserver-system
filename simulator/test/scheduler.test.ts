import { describe, expect, it } from 'vitest';
import { Scheduler, PRIORITY } from '../src/model/scheduler';
import { Clock } from '../src/model/clock';
import { makeConfig, random } from '../src/model/config';

describe('integer event timing', () => {
  it('executes ten short commands within one outer tick, including newly scheduled work', () => {
    const scheduler = new Scheduler();
    const times: number[] = [];
    const command = () => {
      times.push(scheduler.now);
      if (times.length < 10) scheduler.schedule(scheduler.now + 2000, PRIORITY.service, command);
    };
    scheduler.schedule(2000, PRIORITY.service, command);
    scheduler.advanceTo(20000);
    expect(times).toEqual([2000, 4000, 6000, 8000, 10000, 12000, 14000, 16000, 18000, 20000]);
  });
  it('orders commands, deliveries, deadlines, then arrivals and preserves insertion order', () => {
    const scheduler = new Scheduler();
    const order: string[] = [];
    for (const kind of ['arrival', 'deadline', 'service', 'command', 'service'] as const) {
      scheduler.schedule(20, PRIORITY[kind], () => order.push(kind));
    }
    scheduler.advanceTo(20);
    expect(order).toEqual(['command', 'service', 'service', 'deadline', 'arrival']);
  });
  it('removes canceled work without accumulating tombstones', () => {
    const scheduler = new Scheduler();
    for (let i = 0; i < 10000; i++) {
      const id = scheduler.schedule(i, 0, () => { throw new Error('Canceled event executed'); });
      scheduler.cancel(id);
    }
    expect(scheduler.size).toBe(0);
    scheduler.advanceTo(10000);
  });
  it('maintains heap ordering after arbitrary cancellation', () => {
    const scheduler = new Scheduler();
    const times: number[] = [];
    for (let i = 0; i < 1000; i++) {
      const time = Math.floor(random(42, i, 0) * 10000);
      const id = scheduler.schedule(time, 1, () => times.push(time));
      if (i % 3 === 0) scheduler.cancel(id);
    }
    scheduler.advanceTo(10000);
    expect(times).toHaveLength(666);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });
});

describe('clock and workload', () => {
  it('pause, frame cadence and speed affect playback only', () => {
    for (const [frames, elapsed, speed] of [[50, 20, 1], [100, 10, 1], [25, 20, 2], [10, 100, 1]]) {
      let ticks = 0;
      const clock = new Clock(() => ticks++);
      clock.consume(1000);
      expect(ticks).toBe(0);
      clock.setSpeed(speed!);
      clock.resume();
      for (let i = 0; i < frames!; i++) clock.consume(elapsed!);
      expect(ticks).toBe(50);
      clock.pause();
      clock.step();
      expect(ticks).toBe(51);
      clock.reset();
      expect(clock.tick).toBe(0);
      expect(clock.paused).toBe(true);
    }
  });
  it('keeps backlogged steps rather than dropping simulated work', () => {
    const clock = new Clock(() => {});
    clock.resume();
    expect(clock.consume(1000, 5)).toEqual({ steps: 5, behind: true });
    expect(clock.consume(0, 100)).toEqual({ steps: 45, behind: false });
    expect(clock.tick).toBe(50);
  });
  it('validates teaching bounds and uses independent seeded streams', () => {
    expect(() => makeConfig({ rate: Number.NaN })).toThrow();
    expect(() => makeConfig({ replicas: 1.5 })).toThrow();
    expect(() => makeConfig({ capacity: 0 })).toThrow();
    expect(random(476, 100, 1)).toBe(random(476, 100, 1));
    expect(random(477, 100, 1)).not.toBe(random(476, 100, 1));
    expect(random(476, 100, 2)).not.toBe(random(476, 100, 1));
  });
});
