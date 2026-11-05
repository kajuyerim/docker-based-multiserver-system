import type { Completion, Snapshot } from '../model/types';
import { SECOND } from '../model/scheduler';

export interface Metrics {
  windowSeconds: number;
  offeredRate: number;
  successRate: number;
  completedRate: number;
  errorFraction: number | null;
  averageMs: number | null;
  p95Ms: number | null;
  samples: number;
  pending: number;
  oldestMs: number;
  queue: number;
  averageQueue: number;
  cpuUtilization: number;
  redisUtilization: number;
}

export function latency(values: readonly number[]): { average: number | null; p95: number | null } {
  if (values.length === 0) return { average: null, p95: null };
  const ordered = [...values].sort((a, b) => a - b);
  return { average: values.reduce((a, b) => a + b, 0) / values.length,
    p95: ordered[Math.ceil(0.95 * ordered.length) - 1]! };
}

export function queueDepth(snapshot: Snapshot): number {
  return snapshot.backends.reduce((sum, b) => sum + b.cpuQueue, snapshot.redis.queue);
}

type Boundary = Pick<Snapshot, 'now' | 'totals' | 'accounting'> & { redis: Pick<Snapshot['redis'], 'busyUs'> };

export function measure(snapshot: Snapshot, earlier: Boundary): Metrics {
  const elapsed = snapshot.now - earlier.now;
  if (elapsed < 0 || elapsed > 5 * SECOND) throw new Error('Rolling metrics require a window between zero and five seconds');
  const seconds = elapsed / SECOND;
  const completions: readonly Completion[] = snapshot.completions.filter(c => c.at > earlier.now);
  const durations = latency(completions.map(c => c.latencyUs / 1000));
  const failed = snapshot.totals.failed - earlier.totals.failed;
  const succeeded = snapshot.totals.succeeded - earlier.totals.succeeded;
  const completed = failed + succeeded;
  const cpuSlots = snapshot.accounting.cpuSlotsUs - earlier.accounting.cpuSlotsUs;
  return {
    windowSeconds: seconds,
    offeredRate: seconds ? (snapshot.totals.offered - earlier.totals.offered) / seconds : 0,
    successRate: seconds ? succeeded / seconds : 0,
    completedRate: seconds ? completed / seconds : 0,
    errorFraction: completed ? failed / completed : null,
    averageMs: durations.average, p95Ms: durations.p95, samples: completions.length,
    pending: snapshot.requests.length,
    oldestMs: snapshot.requests.reduce((max, r) => Math.max(max, (snapshot.now - r.createdAt) / 1000), 0),
    queue: queueDepth(snapshot),
    averageQueue: elapsed ? (snapshot.accounting.queueAreaUs - earlier.accounting.queueAreaUs) / elapsed : 0,
    cpuUtilization: cpuSlots ? (snapshot.accounting.cpuBusyUs - earlier.accounting.cpuBusyUs) / cpuSlots : 0,
    redisUtilization: elapsed ? (snapshot.redis.busyUs - earlier.redis.busyUs) / elapsed : 0,
  };
}

export interface ChartPoint { time: number; metrics: Metrics }
export class MetricsHistory {
  private snapshots: Boundary[] = [];
  readonly points: ChartPoint[] = [];

  observe(snapshot: Snapshot): Metrics {
    if (this.snapshots.at(-1)?.now === snapshot.now) return this.points.at(-1)!.metrics;
    this.snapshots.push({ now: snapshot.now, totals: snapshot.totals, accounting: snapshot.accounting, redis: { busyUs: snapshot.redis.busyUs } });
    while (this.snapshots.length > 1 && this.snapshots[0]!.now < snapshot.now - 5 * SECOND) this.snapshots.shift();
    const metrics = measure(snapshot, this.snapshots[0]!);
    this.points.push({ time: snapshot.now, metrics });
    while (this.points.length > 301) this.points.shift();
    return metrics;
  }
}
