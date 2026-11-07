import type { DeepReadonly, SemanticEvent, Snapshot, Trace } from '../model/types';

export type ComponentId = 'clients' | 'nginx' | 'redis' | `app${number}`;
export type Segment = readonly [ComponentId, ComponentId];
export interface RequestView {
  event: DeepReadonly<SemanticEvent>;
  index: number;
  total: number;
  title: string;
  explanation: string;
  identity: string;
  locationNote: string;
  component?: ComponentId;
  segment?: Segment;
  path: Segment[];
}

function location(event: DeepReadonly<SemanticEvent>): { component?: ComponentId; segment?: Segment } {
  const app: ComponentId | undefined = event.backend === undefined ? undefined : `app${event.backend}`;
  switch (event.kind) {
    case 'arrival': return { component: 'nginx', segment: ['clients', 'nginx'] };
    case 'routing': return { component: app, segment: app && ['nginx', app] };
    case 'handler': case 'queue': case 'processing': case 'sleep': return { component: app };
    case 'redis-send': return { component: app, segment: app && [app, 'redis'] };
    case 'redis-queue': case 'redis-execute': case 'redis-commit': case 'redis-unavailable': return { component: 'redis' };
    case 'redis-ack': return { component: app, segment: app && ['redis', app] };
    case 'redis-timeout': case 'redis-admission': return { component: app };
    case 'response': case 'attempt-failed': case 'retry': return { component: 'nginx', segment: app && [app, 'nginx'] };
    case 'terminal': return { component: 'clients', segment: ['nginx', 'clients'] };
    default: return {};
  }
}

export function eventLocation(event: DeepReadonly<SemanticEvent>, snapshot: Snapshot): ReturnType<typeof location> {
  const result = location(event);
  if (event.backend !== undefined) {
    const backend = snapshot.backends.find(b => b.id === event.backend);
    if (!backend || (event.incarnation !== undefined && backend.incarnation !== event.incarnation)) {
      if (result.component?.startsWith('app')) result.component = undefined;
      if (result.segment?.some(id => id.startsWith('app'))) result.segment = undefined;
    }
  }
  return result;
}

export function backgroundEvents(snapshot: Snapshot, displayTime: number, followedRequest?: number): DeepReadonly<SemanticEvent>[] {
  return snapshot.events.filter(event => event.request !== undefined && event.request !== followedRequest &&
    displayTime - event.at >= 0 && displayTime - event.at < 400_000 && eventLocation(event, snapshot).segment).slice(-200);
}

function describe(event: DeepReadonly<SemanticEvent>, trace: DeepReadonly<Trace>): [string, string] {
  const command = event.redisCommand?.toUpperCase() ?? 'Redis command';
  switch (event.kind) {
    case 'arrival': return ['Client request offered', 'One logical request enters NGINX. Later upstream retries belong to this same offered request.'];
    case 'routing': return ['Upstream attempt', event.message];
    case 'handler': return ['Handler entry', trace.route === 'root' ? 'Go accepted GET /. Its local counter advances at entry; Redis and the client response are separate later steps.' : 'Go accepted GET /slow. This route does not increment either counter.'];
    case 'queue': return ['CPU queue', 'Runnable work waits for this backend’s modeled CPU slot. Waiting work is distinct from actively executing work.'];
    case 'processing': return ['CPU execution', `${event.message}. This occupies the modeled CPU slot; sleep and Redis waiting do not.`];
    case 'sleep': return ['Sleeping · CPU released', `${event.message}. Other requests can use the CPU; this request makes no Redis call.`];
    case 'redis-send': return [`${command} sent`, `${command} travels from Go to Redis. Transport does not occupy Redis execution.${event.redisCommand === 'publish' ? ' Go issues this separate best-effort command after the INCR reply; it does not increment the key.' : ''}`];
    case 'redis-queue': return [`${command} queued`, 'Redis has accepted this command. It waits for the single modeled execution slot and can outlive its caller.'];
    case 'redis-execute': return [`${command} executing`, 'This command owns the single modeled Redis execution slot. Network RTT is separate from execution cost.'];
    case 'redis-commit': return event.redisCommand === 'incr'
      ? ['INCR updated in memory', `This operation atomically produced ${event.redisResult}. That recorded result is not today’s global count or proof of client success or disk durability.`]
      : ['PUBLISH executed', 'The separate best-effort PUBLISH executed. It does not increment the key, undo INCR, or prove delivery to a browser subscriber.'];
    case 'redis-ack': return [`${command} reply reached Go`, event.redisCommand === 'incr'
      ? `Go received this INCR’s recorded result ${event.redisResult}; it can now send the separate best-effort PUBLISH. The client has not necessarily received a response.`
      : 'Go received the PUBLISH acknowledgment. HTTP response work follows; this is not a subscriber-delivery acknowledgment.'];
    case 'redis-timeout': return [`${command} acknowledgment timed out`, `${event.message}.${event.redisCommand === 'publish' ? ' PUBLISH is best effort: an otherwise successful root can still return HTTP 200.' : ' Failed INCR produces terminal HTTP 500, which is not retried.'}`];
    case 'redis-unavailable': return [`${command} failed before update`, `${event.message}.${event.redisCommand === 'publish' ? ' The earlier INCR stays applied; PUBLISH failure does not fail the otherwise successful root.' : ''}`];
    case 'redis-admission': return ['Redis operation limit', 'The synthetic operation limit rejected this work. This is model admission control, not a measured Redis limit.'];
    case 'attempt-failed': return ['Upstream failed', `${event.message}. An earlier accepted INCR can remain applied or execute after this failure.`];
    case 'retry': return ['Retry · same client request', 'NGINX may choose another eligible, untried backend. This adds an upstream attempt, not an offered client request, and may repeat GET / side effects.'];
    case 'response': return ['Backend response sent', 'Go sent its response toward NGINX. Only the later client-result event establishes delivery to the modeled client.'];
    case 'terminal': return [event.outcome === 'success' ? 'Client success' : 'Client failure', `Client result: ${event.outcome}. This closes the logical request; accepted Redis work can remain outstanding and committed increments are not rolled back.`];
    default: return [event.kind, event.message];
  }
}

export function requestView(trace: DeepReadonly<Trace>, snapshot: Snapshot, sequence?: number): RequestView | undefined {
  const index = sequence === undefined ? trace.events.length - 1 : trace.events.findIndex(e => e.sequence === sequence);
  const event = trace.events[index];
  if (!event) return undefined;
  const [title, explanation] = describe(event, trace);
  const backend = snapshot.backends.find(b => b.id === event.backend);
  const locationNote = event.backend === undefined ? '' : !backend ? `app${event.backend} has been removed; its old position is not reconstructed.`
    : event.incarnation !== undefined && backend.incarnation !== event.incarnation ? `Current app${backend.id} is incarnation ${backend.incarnation}; this event belongs to incarnation ${event.incarnation}. Its old process is not highlighted.` : '';
  const path: Segment[] = [];
  for (const item of trace.events.slice(0, index + 1)) {
    const segment = eventLocation(item, snapshot).segment;
    if (segment && !path.some(s => s[0] === segment[0] && s[1] === segment[1])) path.push(segment);
  }
  return { event, index, total: trace.events.length, title, explanation, locationNote, path,
    identity: [`Request ${trace.id}`, event.attempt === undefined ? '' : `attempt ${event.attempt}`,
      event.backend === undefined ? '' : `app${event.backend} · incarnation ${event.incarnation ?? 'not recorded'}`,
      event.operation === undefined ? '' : `operation ${event.operation}`].filter(Boolean).join(' / '),
    ...eventLocation(event, snapshot) };
}

export function pressure(snapshot: Snapshot, component: ComponentId): [string, number][] {
  const backend = snapshot.backends.find(b => `app${b.id}` === component);
  if (backend) return [['CPU queued', backend.cpuQueue], ['CPU active', Number(backend.cpuActive)], ['Sleeping', backend.sleeping], ['Redis wait', backend.redisWaiting]];
  if (component === 'redis') return [['Queued', snapshot.redis.queue], ['Executing', Number(snapshot.redis.active)],
    ['In transport', snapshot.redis.operations - snapshot.redis.queue - Number(snapshot.redis.active)], ['Detached', snapshot.redis.detached]];
  if (component === 'nginx') return [['Client contexts', snapshot.requests.length], ['Attempts total', snapshot.totals.attempts], ['Retries total', snapshot.totals.retried]];
  return [['Offered total', snapshot.totals.offered], ['Succeeded total', snapshot.totals.succeeded], ['Failed total', snapshot.totals.failed]];
}

export function metricTarget(metric: string, snapshot: Snapshot): { component: ComponentId; explanation: string } {
  const backend = [...snapshot.backends].sort((a, b) => b.cpuQueue - a.cpuQueue || Number(b.cpuActive) - Number(a.cpuActive) || a.id - b.id)[0]!;
  switch (metric) {
    case 'cpu': return { component: `app${backend.id}`, explanation: 'CPU utilization is measured over the rolling window across modeled CPU slots. This backend has the largest current CPU queue (active work breaks ties). Sleeping and Redis waiting release CPU.' };
    case 'redis-util': return { component: 'redis', explanation: 'Redis utilization counts execution time in one modeled slot. Network RTT and waiting commands do not consume that slot. Current counts below distinguish queue, execution and transport.' };
    case 'queue': return { component: snapshot.redis.queue > backend.cpuQueue ? 'redis' : `app${backend.id}`, explanation: 'Queued is the current total of Go CPU queues and the Redis execution queue. This component has the largest current queue. Sleep and network transport are separate.' };
    case 'global': return { component: 'redis', explanation: 'Global count advances when INCR executes in memory. It can include increments whose clients failed or whose requests were retried. It is not a delivered-response or durability count.' };
    case 'throughput': return { component: 'clients', explanation: 'Successful and offered rates use the displayed rolling window. A retry is another upstream attempt within one offered logical request.' };
    case 'errors': return { component: 'nginx', explanation: 'Errors are the failed fraction of completed clients in the rolling window. Retried attempts are not separate client failures; accepted Redis work can still complete after a client fails.' };
    case 'p95': return { component: 'nginx', explanation: 'P95 and average latency use completed clients in the rolling window, including failures. Unfinished requests are excluded; inspect in-flight age as well.' };
    default: return { component: 'nginx', explanation: 'In flight counts unfinished logical requests, not upstream attempts. Oldest age exposes waiting that the completed-client latency cohort cannot yet show.' };
  }
}

export class TraceCursor {
  id = 1;
  following = false;
  sequence?: number;
  trace?: DeepReadonly<Trace>;
  select(id: number): void { this.id = id; this.sequence = undefined; this.trace = undefined; this.following = true; }
  observe(snapshot: Snapshot): void { this.trace = snapshot.traces.find(t => t.id === this.id); }
  move(delta: number): void {
    const events = this.trace?.events;
    if (!events?.length) return;
    const index = this.sequence === undefined ? events.length - 1 : events.findIndex(e => e.sequence === this.sequence);
    this.sequence = events[Math.max(0, Math.min(events.length - 1, index + delta))]!.sequence;
    this.following = true;
  }
  view(snapshot: Snapshot): RequestView | undefined { return this.trace && requestView(this.trace, snapshot, this.sequence); }
}
