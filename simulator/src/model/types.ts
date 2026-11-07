import type { Config } from './config';

export type DeepReadonly<T> = T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;
export type Route = 'root' | 'slow';
export type ProcessState = 'running' | 'draining' | 'stopped' | 'starting';
export type Stage = 'routing' | 'connecting' | 'cpu' | 'sleeping' | 'redis' | 'responding';
export type Outcome = 'success' | 'http_500' | 'proxy_failure' | 'model_admission_rejected';

export type Command =
  | { type: 'traffic'; rate?: number; slowPercent?: number; slowSeconds?: number; jitter?: number }
  | { type: 'capacity'; backend: number; value: number }
  | { type: 'admission'; backend: number; value: number }
  | { type: 'add'; capacity?: number }
  | { type: 'stop' | 'restart' | 'drain' | 'remove'; backend: number }
  | { type: 'retry'; enabled: boolean }
  | { type: 'redis'; online?: boolean; incrMs?: number; publishMs?: number; rttMs?: number };

export interface RecordedCommand { tick: number; command: Command; applied?: boolean; error?: string }
export interface SemanticEvent {
  sequence: number;
  at: number;
  kind: string;
  message: string;
  request?: number;
  attempt?: number;
  backend?: number;
  incarnation?: number;
  operation?: number;
  redisCommand?: 'incr' | 'publish';
  redisResult?: number;
  outcome?: Outcome;
}
export interface Trace {
  id: number;
  route: Route;
  startedAt: number;
  finishedAt?: number;
  outcome?: Outcome;
  events: SemanticEvent[];
  omittedEvents: number;
}
export interface Completion {
  id: number;
  at: number;
  latencyUs: number;
  outcome: Outcome;
  attempts: number;
  backend?: number;
}
export interface Totals {
  offered: number;
  succeeded: number;
  failed: number;
  attempts: number;
  retried: number;
  rejected: number;
  localEntries: number;
  globalCount: number;
  publishFailures: number;
}
export interface BackendSnapshot {
  id: number;
  incarnation: number;
  state: ProcessState;
  capacity: number;
  inFlightLimit: number;
  localCount: number;
  completed: number;
  attempts: number;
  inFlight: number;
  cpuQueue: number;
  cpuActive: boolean;
  sleeping: number;
  redisWaiting: number;
  busyUs: number;
  excludedUntil: number;
  removing: boolean;
  withdrawn: boolean;
}
export interface RequestSnapshot {
  id: number;
  route: Route;
  createdAt: number;
  attempt: number;
  backend?: number;
  stage: Stage;
  stageSince: number;
}
export interface SnapshotData {
  version: string;
  now: number;
  tick: number;
  config: Config;
  initialConfig: Config;
  totals: Totals;
  backends: BackendSnapshot[];
  requests: RequestSnapshot[];
  redis: { online: boolean; queue: number; active: boolean; operations: number; detached: number; busyUs: number };
  completions: Completion[];
  events: SemanticEvent[];
  traces: Trace[];
  commands: RecordedCommand[];
  pendingCommands: number;
  scheduledEvents: number;
  workloadHash: number;
  accounting: { queueAreaUs: number; queuePeak: number; cpuBusyUs: number; cpuSlotsUs: number };
}
export type Snapshot = DeepReadonly<SnapshotData>;
