import { LIMITS, MODEL_VERSION, makeConfig, random, validateConfig } from './config';
import type { Config } from './config';
import { PRIORITY, Scheduler, SECOND, TICK_US } from './scheduler';
import type { BackendSnapshot, Command, Completion, Outcome, ProcessState, RecordedCommand, Route,
  SemanticEvent, Snapshot, Stage, Totals, Trace } from './types';

interface Request {
  id: number; route: Route; createdAt: number; slowUs: number;
  tried: number[]; attempt: number; stage: Stage; stageSince: number;
}
interface Attempt {
  id: number; request: number; backend: number; incarnation: number;
  events: Set<number>; operation?: number; entered: boolean;
}
interface CpuTask { attempt: number; work: number; response: boolean; outcome: Outcome }
interface Backend {
  id: number; incarnation: number; state: ProcessState; capacity: number; inFlightLimit: number;
  localCount: number; completed: number; attempts: number; excludedUntil: number;
  members: Set<number>; queue: CpuTask[]; active?: CpuTask; cpuStart: number; cpuEvent?: number;
  busyUs: number; drainEvent?: number; restartEvent?: number; removing: boolean; withdrawn: boolean;
}
interface RedisOperation {
  id: number; attempt: number; request: number; kind: 'incr' | 'publish';
  backend: number; incarnation: number; result?: number;
  state: 'outbound' | 'queued' | 'executing' | 'reply'; events: Set<number>;
  halfRtt: number;
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export class Engine {
  private scheduler = new Scheduler(elapsed => this.accountResources(elapsed));
  private config: Config;
  private initialConfig: Config;
  private backends: Backend[] = [];
  private requests = new Map<number, Request>();
  private attempts = new Map<number, Attempt>();
  private operations = new Map<number, RedisOperation>();
  private redisQueue: number[] = [];
  private redisActive?: number;
  private redisStart = 0;
  private redisBusyUs = 0;
  private totals: Totals = { offered: 0, succeeded: 0, failed: 0, attempts: 0, retried: 0,
    rejected: 0, localEntries: 0, globalCount: 0, publishFailures: 0 };
  private events: SemanticEvent[] = [];
  private traces = new Map<number, Trace>();
  private pinnedTrace?: Trace;
  private completions: Completion[] = [];
  private commands: RecordedCommand[] = [];
  private pendingCommands = 0;
  private sequence = 0;
  private nextBackend = 0;
  private nextAttempt = 0;
  private nextOperation = 0;
  private roundRobin = 0;
  private arrivalEvent?: number;
  private workloadHash = 2166136261;
  private queueAreaUs = 0;
  private queuePeak = 0;
  private cpuBusyUs = 0;
  private cpuSlotsUs = 0;

  constructor(overrides: Partial<Config> = {}) {
    this.config = makeConfig(overrides);
    this.initialConfig = { ...this.config };
    for (let i = 0; i < this.config.replicas; i++) this.addBackend(this.config.capacity);
    this.scheduleArrival();
  }

  get now(): number { return this.scheduler.now; }
  get tick(): number { return this.now / TICK_US; }

  step(): void {
    this.scheduler.advanceTo(this.now + TICK_US);
    const cutoff = this.now - 5 * SECOND;
    while (this.completions[0] && this.completions[0].at <= cutoff) this.completions.shift();
  }

  runFor(seconds: number): void {
    const ticks = seconds * SECOND / TICK_US;
    if (!Number.isSafeInteger(ticks) || ticks < 0) throw new Error('Duration must be a nonnegative whole number of ticks');
    for (let i = 0; i < ticks; i++) this.step();
  }

  command(command: Command, tick = this.tick + 1): void {
    this.queueCommand(command, tick, true);
  }

  replay(commands: readonly RecordedCommand[]): void {
    for (const record of commands) this.queueCommand(record.command, record.tick, false);
  }

  private queueCommand(command: Command, tick: number, validateNow: boolean): void {
    if (!Number.isSafeInteger(tick) || tick <= this.tick) throw new Error('Command must target a future tick');
    if (this.commands.length >= LIMITS.commands) throw new Error('Action recording is full; reset the experiment to continue');
    if (validateNow) this.validateCommand(command);
    const copy = structuredClone(command);
    const record: RecordedCommand = { tick, command: copy };
    this.commands.push(record);
    this.pendingCommands++;
    this.scheduler.schedule(tick * TICK_US, PRIORITY.command, () => {
      this.pendingCommands--;
      // Earlier commands can remove a target before a future replay action runs.
      try { this.validateCommand(copy); this.apply(copy); record.applied = true; }
      catch (error) { record.applied = false; record.error = String(error); this.emit('command-rejected', String(error)); }
    });
  }

  pinTrace(id: number): boolean {
    const trace = this.traces.get(id) ?? (this.pinnedTrace?.id === id ? this.pinnedTrace : undefined);
    if (!trace) return false;
    this.pinnedTrace = trace;
    return true;
  }

  snapshot(): Snapshot {
    const backends: BackendSnapshot[] = this.backends.map(b => {
      const requests = [...b.members].map(id => this.requests.get(this.attempts.get(id)!.request));
      return {
        id: b.id, incarnation: b.incarnation, state: b.state, capacity: b.capacity,
        inFlightLimit: b.inFlightLimit, localCount: b.localCount, completed: b.completed,
        attempts: b.attempts, inFlight: b.members.size, cpuQueue: b.queue.length,
        cpuActive: b.active !== undefined, sleeping: requests.filter(r => r?.stage === 'sleeping').length,
        redisWaiting: requests.filter(r => r?.stage === 'redis').length,
        busyUs: b.busyUs + (b.active ? this.now - b.cpuStart : 0),
        excludedUntil: b.excludedUntil, removing: b.removing, withdrawn: b.withdrawn,
      };
    });
    return freeze({
      version: MODEL_VERSION, now: this.now, tick: this.tick,
      config: { ...this.config }, initialConfig: { ...this.initialConfig }, totals: { ...this.totals }, backends,
      requests: [...this.requests.values()].map(r => ({ id: r.id, route: r.route, createdAt: r.createdAt,
        attempt: r.attempt, backend: this.attempts.get(r.attempt)?.backend, stage: r.stage, stageSince: r.stageSince })),
      redis: { online: this.config.redisOnline, queue: this.redisQueue.length,
        active: this.redisActive !== undefined, operations: this.operations.size,
        detached: [...this.operations.values()].filter(o => this.attempts.get(o.attempt)?.operation !== o.id).length,
        busyUs: this.redisBusyUs + (this.redisActive !== undefined ? this.now - this.redisStart : 0) },
      completions: this.completions.map(c => ({ ...c })),
      events: this.events.map(e => ({ ...e })),
      traces: [...this.traces.values(), ...(this.pinnedTrace && !this.traces.has(this.pinnedTrace.id) ? [this.pinnedTrace] : [])].map(t => ({ ...t, events: t.events.map(e => ({ ...e })) })),
      commands: structuredClone(this.commands), pendingCommands: this.pendingCommands,
      scheduledEvents: this.scheduler.size, workloadHash: this.workloadHash,
      accounting: { queueAreaUs: this.queueAreaUs, queuePeak: this.queuePeak,
        cpuBusyUs: this.cpuBusyUs, cpuSlotsUs: this.cpuSlotsUs },
    });
  }

  private accountResources(elapsed: number): void {
    const queue = this.backends.reduce((sum, b) => sum + b.queue.length, this.redisQueue.length);
    this.queuePeak = Math.max(this.queuePeak, queue);
    this.queueAreaUs += queue * elapsed;
    this.cpuSlotsUs += this.backends.length * elapsed;
    this.cpuBusyUs += this.backends.filter(b => b.active).length * elapsed;
  }

  private validateCommand(command: Command): void {
    const config = { ...this.config };
    if ('backend' in command && !this.backends.some(b => b.id === command.backend)) throw new Error('Backend no longer exists');
    switch (command.type) {
      case 'traffic': Object.assign(config, command); break;
      case 'capacity': config.capacity = command.value; break;
      case 'admission': config.inFlightLimit = command.value; break;
      case 'add':
        if (this.backends.length >= LIMITS.replicas) throw new Error('Maximum eight replicas');
        config.capacity = command.capacity ?? config.capacity;
        break;
      case 'remove':
        if (this.backends.filter(b => !b.removing).length <= 1) throw new Error('Keep one building; stop it to explore total outage');
        if (this.backend(command.backend).removing) throw new Error('Removal is already draining');
        break;
      case 'restart':
        if (this.backend(command.backend).removing) throw new Error('Cannot restart a building being removed');
        break;
      case 'redis':
        config.redisOnline = command.online ?? config.redisOnline;
        config.redisIncrMs = command.incrMs ?? config.redisIncrMs;
        config.redisPublishMs = command.publishMs ?? config.redisPublishMs;
        config.redisRttMs = command.rttMs ?? config.redisRttMs;
        break;
      case 'retry': config.retry = command.enabled; break;
    }
    validateConfig(config);
  }

  private apply(command: Command): void {
    this.emit('command', JSON.stringify(command), undefined, 'backend' in command ? command.backend : undefined);
    switch (command.type) {
      case 'traffic': {
        const { type: _, ...traffic } = command;
        Object.assign(this.config, traffic);
        if (traffic.rate !== undefined || traffic.jitter !== undefined) {
          if (this.arrivalEvent !== undefined) this.scheduler.cancel(this.arrivalEvent);
          this.scheduleArrival();
        }
        break;
      }
      case 'capacity': {
        const b = this.backend(command.backend);
        if (b.active) {
          b.active.work = Math.max(0, b.active.work - (this.now - b.cpuStart) / SECOND * b.capacity);
          this.accountCpu(b);
          if (b.cpuEvent !== undefined) this.scheduler.cancel(b.cpuEvent);
        }
        b.capacity = command.value;
        if (b.active) this.scheduleCpu(b);
        break;
      }
      case 'admission': this.backend(command.backend).inFlightLimit = command.value; break;
      case 'add': this.addBackend(command.capacity ?? this.config.capacity); this.config.replicas = this.backends.length; break;
      case 'stop': this.stop(this.backend(command.backend)); break;
      case 'restart': this.restart(this.backend(command.backend)); break;
      case 'drain': this.drain(this.backend(command.backend), false); break;
      case 'remove': this.drain(this.backend(command.backend), true); break;
      case 'retry': this.config.retry = command.enabled; break;
      case 'redis':
        this.config.redisIncrMs = command.incrMs ?? this.config.redisIncrMs;
        this.config.redisPublishMs = command.publishMs ?? this.config.redisPublishMs;
        this.config.redisRttMs = command.rttMs ?? this.config.redisRttMs;
        if (command.online !== undefined && command.online !== this.config.redisOnline) {
          this.config.redisOnline = command.online;
          if (!command.online) this.redisOffline();
        }
        break;
    }
  }

  private addBackend(capacity: number): void {
    this.backends.push({ id: ++this.nextBackend, incarnation: 1, state: 'running', capacity,
      inFlightLimit: this.config.inFlightLimit, localCount: 0, completed: 0, attempts: 0,
      excludedUntil: 0, members: new Set(), queue: [], cpuStart: 0, busyUs: 0, removing: false, withdrawn: false });
  }
  private backend(id: number): Backend { return this.backends.find(b => b.id === id)!; }

  private scheduleArrival(): void {
    if (this.config.rate === 0) { this.arrivalEvent = undefined; return; }
    const jitter = 1 + (random(this.config.seed, this.totals.offered + 1, 0) * 2 - 1) * this.config.jitter;
    const interval = Math.max(1, Math.round(SECOND / this.config.rate * jitter));
    this.arrivalEvent = this.scheduler.schedule(this.now + interval, PRIORITY.arrival, () => {
      this.arrive(); this.scheduleArrival();
    });
  }

  private arrive(): void {
    const id = ++this.totals.offered;
    const route = random(this.config.seed, id, 1) < this.config.slowPercent / 100 ? 'slow' : 'root';
    this.workloadHash = Math.imul(this.workloadHash ^ id, 16777619) >>> 0;
    this.workloadHash = Math.imul(this.workloadHash ^ this.now, 16777619) >>> 0;
    this.workloadHash = Math.imul(this.workloadHash ^ (route === 'root' ? 0 : 1), 16777619) >>> 0;
    this.workloadHash = Math.imul(this.workloadHash ^ (route === 'slow' ? Math.round(this.config.slowSeconds * SECOND) : 0), 16777619) >>> 0;
    const request: Request = { id, route, createdAt: this.now, slowUs: Math.round(this.config.slowSeconds * SECOND),
      tried: [], attempt: 0, stage: 'routing', stageSince: this.now };
    this.traces.set(id, { id, route, startedAt: this.now, events: [], omittedEvents: 0 });
    if (this.traces.size > LIMITS.traces) this.traces.delete(this.traces.keys().next().value!);
    this.emit('arrival', `Request ${id}: GET /${route === 'root' ? '' : 'slow'}`, request);
    if (this.requests.size >= LIMITS.requests) { this.finish(request, 'model_admission_rejected'); return; }
    this.requests.set(id, request);
    this.dispatch(request);
  }

  private dispatch(request: Request): void {
    let target: Backend | undefined;
    for (let offset = 0; offset < this.backends.length; offset++) {
      const index = (this.roundRobin + offset) % this.backends.length;
      const candidate = this.backends[index]!;
      if (candidate.withdrawn || candidate.removing || request.tried.includes(candidate.id)) continue;
      if (this.backends.length > 1 && candidate.excludedUntil > this.now) continue;
      target = candidate;
      this.roundRobin = (index + 1) % this.backends.length;
      break;
    }
    if (!target) { this.finish(request, 'proxy_failure'); return; }
    request.tried.push(target.id);
    const attempt: Attempt = { id: ++this.nextAttempt, request: request.id, backend: target.id,
      incarnation: target.incarnation, events: new Set(), entered: false };
    this.attempts.set(attempt.id, attempt);
    request.attempt = attempt.id;
    this.totals.attempts++;
    target.attempts++;
    this.setStage(request, 'connecting');
    this.emit('routing', `NGINX → app${target.id}, attempt ${request.tried.length} of 3`, request, target.id);
    this.afterAttempt(attempt, 1000, () => this.enter(attempt));
  }

  private enter(attempt: Attempt): void {
    const b = this.backend(attempt.backend);
    const r = this.requests.get(attempt.request)!;
    if (b.state !== 'running' || b.incarnation !== attempt.incarnation) { this.failAttempt(attempt, 'connection refused'); return; }
    if (b.members.size >= b.inFlightLimit) {
      this.release(attempt); this.finish(r, 'model_admission_rejected', b.id); return;
    }
    attempt.entered = true;
    b.members.add(attempt.id);
    if (r.route === 'root') { b.localCount++; this.totals.localEntries++; }
    this.emit('handler', `app${b.id} accepts ${r.route}${r.route === 'root' ? '; local count advances' : ''}`, r, b.id);
    this.afterAttempt(attempt, 15 * SECOND, () => this.failAttempt(attempt, 'upstream read timeout'), PRIORITY.deadline);
    this.enqueueCpu(attempt, r.route === 'root' ? 0.8 : 0.05, false, 'success');
  }

  private enqueueCpu(attempt: Attempt, work: number, response: boolean, outcome: Outcome): void {
    const b = this.backend(attempt.backend);
    const r = this.requests.get(attempt.request)!;
    this.setStage(r, response ? 'responding' : 'cpu');
    b.queue.push({ attempt: attempt.id, work, response, outcome });
    this.emit('queue', `Waiting for app${b.id} CPU${response ? ' response work' : ''}`, r, b.id);
    this.startCpu(b);
  }

  private startCpu(b: Backend): void {
    if (b.active || b.queue.length === 0 || (b.state !== 'running' && b.state !== 'draining')) return;
    b.active = b.queue.shift()!;
    this.scheduleCpu(b);
    const a = this.attempts.get(b.active.attempt)!;
    this.emit('processing', `app${b.id} executes ${b.active.work.toFixed(2)} CPU work units`, this.requests.get(a.request), b.id);
  }

  private scheduleCpu(b: Backend): void {
    b.cpuStart = this.now;
    b.cpuEvent = this.scheduler.schedule(this.now + Math.max(1, Math.ceil(b.active!.work / b.capacity * SECOND)), PRIORITY.service, () => {
      const task = b.active!;
      this.accountCpu(b);
      b.active = undefined; b.cpuEvent = undefined;
      const attempt = this.attempts.get(task.attempt)!;
      const r = this.requests.get(attempt.request)!;
      if (task.response) {
        const response = task.outcome === 'success' ? 'HTTP 200' : task.outcome === 'http_500' ? 'HTTP 500' : 'a model admission rejection';
        this.emit('response', `app${b.id} sends ${response}`, r, b.id);
        this.afterAttempt(attempt, 1000, () => {
          b.completed++;
          this.release(attempt);
          this.finish(r, task.outcome, b.id);
        });
      } else if (r.route === 'slow') {
        this.setStage(r, 'sleeping');
        this.emit('sleep', `Sleeping for ${r.slowUs / SECOND}s; CPU is free`, r, b.id);
        this.afterAttempt(attempt, r.slowUs, () => this.enqueueCpu(attempt, 0.05, true, 'success'));
      } else this.sendRedis(attempt, 'incr');
      this.startCpu(b);
    });
  }

  private accountCpu(b: Backend): void {
    if (b.active) b.busyUs += this.now - b.cpuStart;
    b.cpuStart = this.now;
  }

  private sendRedis(attempt: Attempt, kind: 'incr' | 'publish'): void {
    const r = this.requests.get(attempt.request)!;
    this.setStage(r, 'redis');
    if (this.operations.size >= LIMITS.redisOperations) {
      this.emit('redis-admission', 'Model Redis operation limit reached', r, attempt.backend);
      if (kind === 'incr') this.enqueueCpu(attempt, 0.2, true, 'model_admission_rejected');
      else this.redisResult(attempt, kind, false);
      return;
    }
    const op: RedisOperation = { id: ++this.nextOperation, attempt: attempt.id, request: r.id,
      kind, backend: attempt.backend, incarnation: attempt.incarnation,
      state: 'outbound', events: new Set(), halfRtt: Math.round(this.config.redisRttMs * 500) };
    this.operations.set(op.id, op);
    attempt.operation = op.id;
    this.emit('redis-send', `Send ${kind.toUpperCase()}`, r, attempt.backend, op.id);
    this.afterOperation(op, op.halfRtt, () => {
      if (!this.config.redisOnline) { this.rejectOperation(op); return; }
      op.state = 'queued';
      this.redisQueue.push(op.id);
      this.emit('redis-queue', `${kind.toUpperCase()} accepted by Redis`, this.requests.get(op.request), attempt.backend, op.id);
      this.startRedis();
    });
    // INCR's 3 s acknowledgment deadline is a teaching approximation; PUBLISH's 500 ms is the project contract.
    this.afterAttempt(attempt, kind === 'publish' ? 500_000 : 3 * SECOND, () => {
      if (attempt.operation !== op.id) return;
      attempt.operation = undefined;
      this.emit('redis-timeout', `${kind.toUpperCase()} acknowledgment deadline; accepted work may still commit`, r, attempt.backend, op.id);
      if (op.state === 'outbound') this.deleteOperation(op);
      this.redisResult(attempt, kind, false);
    }, PRIORITY.deadline);
  }

  private startRedis(): void {
    if (this.redisActive !== undefined || !this.config.redisOnline || this.redisQueue.length === 0) return;
    const op = this.operations.get(this.redisQueue.shift()!)!;
    this.redisActive = op.id;
    this.redisStart = this.now;
    op.state = 'executing';
    const cost = op.kind === 'incr' ? this.config.redisIncrMs : this.config.redisPublishMs;
    this.emit('redis-execute', `Redis executes ${op.kind.toUpperCase()}`, this.requests.get(op.request), undefined, op.id);
    this.afterOperation(op, Math.round(cost * 1000), () => {
      this.redisBusyUs += this.now - this.redisStart;
      this.redisActive = undefined;
      if (op.kind === 'incr') op.result = ++this.totals.globalCount;
      this.emit('redis-commit', `${op.kind.toUpperCase()} committed${op.kind === 'incr' ? `; global count ${this.totals.globalCount}` : ''}`,
        this.requests.get(op.request), undefined, op.id, op.request);
      op.state = 'reply';
      this.afterOperation(op, op.halfRtt, () => {
        const a = this.attempts.get(op.attempt);
        if (a?.operation === op.id) {
          a.operation = undefined;
          this.emit('redis-ack', `${op.kind.toUpperCase()} acknowledged`, this.requests.get(a.request), a.backend, op.id);
          this.deleteOperation(op);
          this.redisResult(a, op.kind, true);
        } else this.deleteOperation(op);
      });
      this.startRedis();
    });
  }

  private redisResult(attempt: Attempt, kind: 'incr' | 'publish', success: boolean): void {
    if (kind === 'incr' && success) this.sendRedis(attempt, 'publish');
    else {
      if (kind === 'publish' && !success) this.totals.publishFailures++;
      this.enqueueCpu(attempt, 0.2, true, kind === 'incr' ? 'http_500' : 'success');
    }
  }

  private rejectOperation(op: RedisOperation): void {
    const a = this.attempts.get(op.attempt);
    this.emit('redis-unavailable', `${op.kind.toUpperCase()} failed before commit`, this.requests.get(op.request), a?.backend, op.id, op.request);
    this.deleteOperation(op);
    if (a?.operation === op.id) { a.operation = undefined; this.redisResult(a, op.kind, false); }
  }

  private redisOffline(): void {
    if (this.redisActive !== undefined) this.redisBusyUs += this.now - this.redisStart;
    this.redisActive = undefined;
    this.redisQueue = [];
    for (const op of [...this.operations.values()]) if (op.state !== 'reply') this.rejectOperation(op);
  }

  private deleteOperation(op: RedisOperation): void {
    for (const event of op.events) this.scheduler.cancel(event);
    this.operations.delete(op.id);
  }

  private failAttempt(attempt: Attempt, reason: string): void {
    const r = this.requests.get(attempt.request)!;
    const b = this.backend(attempt.backend);
    b.excludedUntil = this.now + 10 * SECOND;
    this.emit('attempt-failed', `${reason}; app${b.id} passively excluded for 10s (ignored for a single upstream)`, r, b.id);
    this.release(attempt);
    if (this.config.retry && r.tried.length < 3) {
      this.totals.retried++;
      this.emit('retry', 'NGINX tries another eligible upstream', r, b.id);
      this.dispatch(r);
    } else this.finish(r, 'proxy_failure', b.id);
  }

  private release(attempt: Attempt): void {
    for (const event of attempt.events) this.scheduler.cancel(event);
    if (attempt.operation !== undefined) {
      const op = this.operations.get(attempt.operation);
      if (op?.state === 'outbound') this.deleteOperation(op);
    }
    const b = this.backend(attempt.backend);
    b.members.delete(attempt.id);
    b.queue = b.queue.filter(t => t.attempt !== attempt.id);
    if (b.active?.attempt === attempt.id) {
      this.accountCpu(b);
      if (b.cpuEvent !== undefined) this.scheduler.cancel(b.cpuEvent);
      b.active = undefined; b.cpuEvent = undefined;
    }
    this.attempts.delete(attempt.id);
    this.startCpu(b);
    this.checkDrained(b);
  }

  private finish(r: Request, outcome: Outcome, backend?: number): void {
    this.requests.delete(r.id);
    if (outcome === 'success') this.totals.succeeded++;
    else this.totals.failed++;
    if (outcome === 'model_admission_rejected') this.totals.rejected++;
    this.completions.push({ id: r.id, at: this.now, latencyUs: this.now - r.createdAt,
      outcome, attempts: r.tried.length, backend });
    const trace = this.traces.get(r.id) ?? (this.pinnedTrace?.id === r.id ? this.pinnedTrace : undefined);
    if (trace) { trace.finishedAt = this.now; trace.outcome = outcome; }
    this.emit('terminal', `Client result: ${outcome}`, r, backend, undefined, r.id, outcome);
  }

  private stop(b: Backend): void {
    b.state = 'stopped';
    if (b.drainEvent !== undefined) this.scheduler.cancel(b.drainEvent);
    if (b.restartEvent !== undefined) this.scheduler.cancel(b.restartEvent);
    b.drainEvent = undefined; b.restartEvent = undefined;
    for (const a of [...this.attempts.values()]) if (a.backend === b.id && a.entered) this.failAttempt(a, 'connection lost');
    this.checkDrained(b);
  }

  private restart(b: Backend): void {
    this.stop(b);
    b.state = 'starting';
    b.withdrawn = false;
    b.incarnation++;
    b.localCount = 0;
    b.restartEvent = this.scheduler.schedule(this.now + 500_000, PRIORITY.service, () => {
      b.state = 'running'; b.restartEvent = undefined;
      this.emit('restarted', `app${b.id} ready; NGINX still uses passive eligibility`, undefined, b.id);
    });
  }

  private drain(b: Backend, remove: boolean): void {
    b.removing ||= remove;
    b.withdrawn = true;
    if (b.state === 'stopped') { this.checkDrained(b); return; }
    if (b.restartEvent !== undefined) this.scheduler.cancel(b.restartEvent);
    b.restartEvent = undefined;
    b.state = 'draining';
    if (b.drainEvent === undefined) {
      b.drainEvent = this.scheduler.schedule(this.now + 12 * SECOND, PRIORITY.deadline, () => this.stop(b));
    }
    this.checkDrained(b);
  }

  private checkDrained(b: Backend): void {
    if ((b.state === 'draining' || b.removing) && b.members.size === 0) {
      if (b.drainEvent !== undefined) this.scheduler.cancel(b.drainEvent);
      b.drainEvent = undefined;
      b.state = 'stopped';
      this.emit('drained', `app${b.id} finished all admitted work`, undefined, b.id);
      if (b.removing) {
        // Releasing pending attempts must not recursively finalize this removal.
        b.removing = false;
        // Refused connections still carry the removed upstream identity until their retry decision.
        for (const a of [...this.attempts.values()]) if (a.backend === b.id) this.failAttempt(a, 'upstream removed');
        this.backends = this.backends.filter(candidate => candidate.id !== b.id);
        this.config.replicas = this.backends.length;
      }
    }
  }

  private setStage(r: Request, stage: Stage): void { r.stage = stage; r.stageSince = this.now; }
  private afterAttempt(a: Attempt, delay: number, run: () => void, priority: number = PRIORITY.service): void {
    const event = this.scheduler.schedule(this.now + delay, priority, () => { a.events.delete(event); run(); });
    a.events.add(event);
  }
  private afterOperation(op: RedisOperation, delay: number, run: () => void): void {
    const event = this.scheduler.schedule(this.now + delay, PRIORITY.service, () => { op.events.delete(event); run(); });
    op.events.add(event);
  }
  private emit(kind: string, message: string, request?: Request, backend?: number, operation?: number, requestId = request?.id, outcome?: Outcome): void {
    const origin = operation === undefined ? undefined : this.operations.get(operation);
    requestId = origin?.request ?? requestId;
    backend = origin?.backend ?? backend;
    const attempt = origin?.attempt ?? (request?.attempt || undefined);
    const event: SemanticEvent = { sequence: ++this.sequence, at: this.now, kind, message,
      request: requestId, attempt, backend, operation, outcome,
      incarnation: origin?.incarnation ?? (attempt === undefined ? undefined : this.attempts.get(attempt)?.incarnation) ??
        this.backends.find(b => b.id === backend)?.incarnation,
      redisCommand: origin?.kind, redisResult: origin?.result };
    this.events.push(event);
    if (this.events.length > LIMITS.events) this.events.shift();
    const trace = requestId === undefined ? undefined : this.traces.get(requestId) ?? (this.pinnedTrace?.id === requestId ? this.pinnedTrace : undefined);
    if (trace) {
      if (trace.events.length < LIMITS.traceEvents) trace.events.push(event);
      else trace.omittedEvents++;
    }
  }
}
