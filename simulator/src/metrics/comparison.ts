import type { Config } from '../model/config';
import type { Command, RecordedCommand, Snapshot } from '../model/types';
import { SECOND, TICK_US } from '../model/scheduler';
import { latency, queueDepth } from './metrics';

export const OBSERVATION = { start: 5 * SECOND, end: 20 * SECOND } as const;
export interface RunValues {
  offered: number; completed: number; failed: number; successRate: number;
  averageMs: number | null; p95Ms: number | null; averageQueue: number; peakSampledQueue: number;
  pending: number; oldestMs: number; cpuUtilization: number; redisUtilization: number;
  localIncrements: number; globalIncrements: number;
}
export interface RecordedRun {
  version: string; seed: number; initialConfig: Config; commands: RecordedCommand[];
  start: number; end: number; offeredHash: number; startHash: number;
  values: RunValues; invalidReason?: string;
}

export class RunRecorder {
  private start?: Pick<Snapshot, 'now' | 'totals' | 'accounting' | 'workloadHash'> & { redis: { busyUs: number } };
  private incomplete = false;
  private lastTime = -1;
  private latencies: number[] = [];
  private peakSampledQueue = 0;
  result?: RecordedRun;

  observe(snapshot: Snapshot): void {
    if (this.result || snapshot.now <= this.lastTime) return;
    if (snapshot.now === OBSERVATION.start) this.start = { now: snapshot.now, totals: snapshot.totals, accounting: snapshot.accounting, workloadHash: snapshot.workloadHash, redis: { busyUs: snapshot.redis.busyUs } };
    if (snapshot.now > OBSERVATION.start && snapshot.now <= OBSERVATION.end) {
      this.peakSampledQueue = Math.max(this.peakSampledQueue, queueDepth(snapshot));
      for (const c of snapshot.completions) {
        if (c.at > Math.max(this.lastTime, OBSERVATION.start)) this.latencies.push(c.latencyUs / 1000);
      }
    }
    const gap = this.lastTime >= 0 && snapshot.now - this.lastTime > 5 * SECOND;
    if (gap && snapshot.now > OBSERVATION.start) this.incomplete = true;
    this.lastTime = snapshot.now;
    if (snapshot.now < OBSERVATION.end) return;
    const start = this.start ?? snapshot;
    const time = snapshot.now - start.now;
    const quantiles = latency(this.latencies);
    const failed = snapshot.totals.failed - start.totals.failed;
    const success = snapshot.totals.succeeded - start.totals.succeeded;
    const cpuSlots = snapshot.accounting.cpuSlotsUs - start.accounting.cpuSlotsUs;
    const commands: RecordedCommand[] = snapshot.commands.filter(c => c.tick * TICK_US <= OBSERVATION.end)
      .map(c => ({ tick: c.tick, command: structuredClone(c.command) as Command, applied: c.applied, error: c.error }));
    let invalidReason: string | undefined;
    if (!this.start || snapshot.now !== OBSERVATION.end || this.incomplete) invalidReason = 'The complete 5–20 s observation window was not recorded.';
    if (this.latencies.length !== failed + success) invalidReason = 'The completed-request cohort is incomplete.';
    if (commands.some(c => c.applied === false)) invalidReason = 'An intervention referenced an invalid state or component. Start a new run.';
    this.result = {
      version: snapshot.version, seed: snapshot.config.seed, initialConfig: { ...snapshot.initialConfig }, commands,
      start: OBSERVATION.start, end: OBSERVATION.end, offeredHash: snapshot.workloadHash, startHash: start.workloadHash,
      invalidReason,
      values: {
        offered: snapshot.totals.offered - start.totals.offered, completed: failed + success, failed,
        successRate: time ? success / (time / SECOND) : 0,
        averageMs: quantiles.average, p95Ms: quantiles.p95,
        averageQueue: time ? (snapshot.accounting.queueAreaUs - start.accounting.queueAreaUs) / time : 0,
        peakSampledQueue: this.peakSampledQueue, pending: snapshot.requests.length,
        oldestMs: snapshot.requests.reduce((max, r) => Math.max(max, (snapshot.now - r.createdAt) / 1000), 0),
        cpuUtilization: cpuSlots ? (snapshot.accounting.cpuBusyUs - start.accounting.cpuBusyUs) / cpuSlots : 0,
        redisUtilization: time ? (snapshot.redis.busyUs - start.redis.busyUs) / time : 0,
        localIncrements: snapshot.totals.localEntries - start.totals.localEntries,
        globalIncrements: snapshot.totals.globalCount - start.totals.globalCount,
      },
    };
  }
}

function trafficRecipe(run: RecordedRun): string {
  const { rate, slowPercent, slowSeconds, jitter } = run.initialConfig;
  return JSON.stringify({ seed: run.seed, rate, slowPercent, slowSeconds, jitter,
    interventions: run.commands.filter(c => c.command.type === 'traffic').map(c => ({ tick: c.tick, command: c.command })) });
}

export interface Comparison { comparable: boolean; reason: string; changes: string[]; delta?: RunValues }
export function compareRuns(baseline: RecordedRun, candidate: RecordedRun): Comparison {
  const changes: string[] = [];
  for (const key of Object.keys(baseline.initialConfig) as (keyof Config)[]) {
    if (baseline.initialConfig[key] !== candidate.initialConfig[key]) changes.push(`${key}: ${baseline.initialConfig[key]} → ${candidate.initialConfig[key]}`);
  }
  const groupByTick = (commands: RecordedCommand[]) => {
    const groups = new Map<number, string[]>();
    for (const command of commands) {
      const group = groups.get(command.tick) ?? [];
      group.push(JSON.stringify(command.command));
      groups.set(command.tick, group);
    }
    return groups;
  };
  const before = groupByTick(baseline.commands), after = groupByTick(candidate.commands);
  const ticks = [...new Set([...before.keys(), ...after.keys()])].sort((a, b) => a - b);
  for (const tick of ticks) {
    const previous = before.get(tick) ?? [], next = after.get(tick) ?? [];
    if (JSON.stringify(previous) !== JSON.stringify(next)) {
      changes.push(`${(tick * TICK_US / SECOND).toFixed(2)} s execution order: [${previous.join('; ')}] → [${next.join('; ')}]`);
    }
  }
  let reason = '';
  if (baseline.invalidReason || candidate.invalidReason) reason = baseline.invalidReason ?? candidate.invalidReason!;
  else if (baseline.version !== candidate.version) reason = 'Model versions differ.';
  else if (baseline.start !== candidate.start || baseline.end !== candidate.end) reason = 'Observation windows differ.';
  else if (trafficRecipe(baseline) !== trafficRecipe(candidate)) reason = 'Workload settings, seed, or traffic interventions differ. Save a new baseline.';
  else if (baseline.startHash !== candidate.startHash || baseline.offeredHash !== candidate.offeredHash) reason = 'The offered request streams differ.';
  if (reason) return { comparable: false, reason, changes };
  const delta = Object.fromEntries(Object.entries(baseline.values).map(([key, value]) => {
    const after = candidate.values[key as keyof RunValues];
    return [key, value === null || after === null ? null : after - value];
  })) as unknown as RunValues;
  return { comparable: true, reason: 'Same offered workload and seed; clean initial state; 5–20 s observation window.', changes, delta };
}
