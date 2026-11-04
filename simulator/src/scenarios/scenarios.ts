import type { Config } from '../model/config';
import type { Command, Snapshot } from '../model/types';
import type { Metrics } from '../metrics/metrics';
import { SECOND } from '../model/scheduler';

export type ScenarioId = 'scaling' | 'outage' | 'drain' | 'redis';
export interface Scenario {
  id: ScenarioId;
  title: string;
  setup: string;
  goal: string;
  action: string;
  config: Partial<Config>;
}

export const SCENARIOS: readonly Scenario[] = [
  { id: 'scaling', title: 'Scale under load',
    setup: '120 requests/s reach one backend with 50 CPU units/s. Watch its runnable queue grow.',
    goal: 'Add two backends. Sustained successful throughput should exceed 110/s while the CPU queue clears.',
    action: 'Add two backends', config: { seed: 476, replicas: 1, rate: 120, capacity: 50, jitter: 0.15 } },
  { id: 'outage', title: 'Lose a backend',
    setup: 'Three backends share 60 requests/s. Two have enough capacity to carry this workload.',
    goal: 'Stop app2 with retries enabled. Find the retry in the console, then sustain more than 55 successful requests/s.',
    action: 'Stop app2', config: { seed: 476, replicas: 3, rate: 60, retry: true } },
  { id: 'drain', title: 'Drain without dropping work',
    setup: '40% of requests sleep for four seconds. A sleeping request still belongs to its backend.',
    goal: 'Withdraw app2, let its admitted requests finish, and observe zero client failures.',
    action: 'Drain app2', config: { seed: 476, replicas: 3, rate: 30, slowPercent: 40, slowSeconds: 4 } },
  { id: 'redis', title: 'Find the shared bottleneck',
    setup: 'Eight backends offer 400 CPU units/s, but 6 ms INCR + 4 ms PUBLISH limit successful roots near 100/s.',
    goal: 'Observe the shared Redis queue, then reduce execution costs. Recover above 200 successful requests/s.',
    action: 'Speed up Redis', config: { seed: 476, replicas: 8, rate: 250, redisIncrMs: 6, redisPublishMs: 4 } },
];

export interface ScenarioProgress { complete: boolean; canAct: boolean; message: string; evidence: string }

export class Experiment {
  readonly definition: Scenario;
  private observedPressure = false;
  private observedDrain = false;
  private lastTime = -1;
  private completed = false;
  private evidence = '';

  constructor(id: ScenarioId) { this.definition = SCENARIOS.find(s => s.id === id)!; }

  actions(snapshot: Snapshot): Command[] {
    const { id } = this.definition;
    if (id === 'scaling') return Array.from({ length: Math.max(0, 3 - snapshot.backends.length) }, () => ({ type: 'add' as const }));
    if (id === 'outage') return [{ type: 'stop', backend: 2 }];
    if (id === 'drain') return [{ type: 'drain', backend: 2 }];
    return [{ type: 'redis', incrMs: 2, publishMs: 1 }];
  }

  observe(snapshot: Snapshot, metrics: Metrics): ScenarioProgress {
    const { id } = this.definition;
    const b = snapshot.backends.find(b => b.id === 2);
    if (snapshot.now !== this.lastTime) {
      this.lastTime = snapshot.now;
      if (id === 'scaling' && snapshot.backends.length === 1 && metrics.queue > 20) this.observedPressure = true;
      if (id === 'redis' && snapshot.redis.queue > 60 && metrics.redisUtilization > 0.9) this.observedPressure = true;
      if (id === 'drain' && b?.state === 'draining' && b.inFlight > 0) this.observedDrain = true;
      const enough = metrics.windowSeconds >= 4 && metrics.samples >= 50;
      let passed = false;
      if (enough && id === 'scaling') passed = this.observedPressure && snapshot.backends.filter(b => b.state === 'running').length >= 3 && metrics.successRate > 110 && metrics.queue < 10;
      if (enough && id === 'outage') passed = b?.state === 'stopped' && snapshot.config.retry && snapshot.totals.retried > 0 && snapshot.totals.failed === 0 && metrics.successRate > 55;
      if (enough && id === 'drain') passed = this.observedDrain && b?.state === 'stopped' && b.withdrawn && b.inFlight === 0 && snapshot.totals.failed === 0 && metrics.successRate > 20;
      if (enough && id === 'redis') passed = this.observedPressure && snapshot.config.redisIncrMs <= 2 && snapshot.config.redisPublishMs <= 1 && metrics.successRate > 200 && snapshot.redis.queue < 20;
      if (passed) {
        this.completed = true;
        this.evidence = `${metrics.successRate.toFixed(1)} successful requests/s; ${metrics.queue} queued; ${(metrics.redisUtilization * 100).toFixed(1)}% Redis utilization; ${snapshot.totals.failed} client failures.`;
      }
    }
    let canAct = false, message = this.definition.goal;
    if (id === 'scaling') { canAct = this.observedPressure && snapshot.backends.length < 3; if (!this.observedPressure) message = 'First observe the queue growing above 20 requests.'; }
    if (id === 'outage') canAct = snapshot.now >= SECOND && b?.state === 'running';
    if (id === 'drain') { canAct = snapshot.now >= 2 * SECOND && b?.state === 'running' && b.inFlight > 0; if (!canAct && !this.observedDrain) message = 'Let slow requests accumulate for at least two simulated seconds.'; }
    if (id === 'redis') { canAct = this.observedPressure && (snapshot.config.redisIncrMs > 2 || snapshot.config.redisPublishMs > 1); if (!this.observedPressure) message = 'First observe Redis above 90% utilization with more than 60 commands queued.'; }
    return { complete: this.completed, canAct: canAct && !this.completed,
      message: this.completed ? 'Observation complete. Keep experimenting or reset this scenario.' : message, evidence: this.evidence };
  }
}
