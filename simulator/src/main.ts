import './ui/styles.css';
import { Engine } from './model/engine';
import { Clock } from './model/clock';
import { DEFAULT_CONFIG, MODEL_VERSION } from './model/config';
import type { Config } from './model/config';
import type { Command, Trace, DeepReadonly } from './model/types';
import { MetricsHistory } from './metrics/metrics';
import type { Metrics } from './metrics/metrics';
import { Campus, backendState } from './view/campus';
import type { ComponentId } from './view/campus';
import { Experiment, SCENARIOS } from './scenarios/scenarios';
import type { ScenarioId } from './scenarios/scenarios';
import { ComparisonPanel } from './ui/comparison-panel';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const number = (value: number, digits = 0) => value.toLocaleString('en', { maximumFractionDigits: digits });
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const slider = (id: string, label: string, value: number, min: number, max: number, unit: string, step = 1, help = '') => `
  <div class="control"><label for="${id}">${label}<output id="${id}-value" for="${id}">${value}${unit}</output></label>
  <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}" />
  <div class="range-ends"><span>${min}${unit}</span><span>${max}${unit}</span></div>${help ? `<small>${help}</small>` : ''}</div>`;

$('app').innerHTML = `
<div class="simulation-shell">
  <div id="campus" role="group" aria-label="Live multiserver map. Select a component label or use Inspect component."></div>
  <header class="instrument-bar" data-scene-overlay>
    <div class="identity"><span class="live-dot" aria-hidden="true"></span><h1>MULTISERVER</h1><span class="rule"></span><span id="sim-time">0.00 s</span><span id="playback-state" class="sr-only">Running</span></div>
    <section class="vitals" aria-label="Live metrics">
      <div class="vital"><span>SUCCESS /s</span><strong id="throughput">0</strong><small>offered <b id="offered">0</b></small></div>
      <div class="vital"><span>ERRORS</span><strong><b id="errors">—</b><i>%</i></strong><small><b id="sample-count">0</b> completed</small></div>
      <div class="vital"><span>P95 / AVG · ms</span><strong><b id="p95">—</b><i> / </i><b id="average">—</b></strong><small>completed cohort</small></div>
      <div class="vital"><span>IN FLIGHT</span><strong id="pending">0</strong><small>oldest <b id="oldest">0</b> ms</small></div>
      <div class="vital"><span>CPU / REDIS</span><strong><b id="cpu">0</b><i>% / </i><b id="redis-util">0</b><i>%</i></strong><small><b id="queue">0</b> queued</small></div>
      <div class="vital"><span>GLOBAL COUNT</span><strong id="global">0</strong><small>committed INCR</small></div>
    </section>
    <div class="utility-row"><span class="model-disclosure">EDUCATIONAL MODEL <span>· synthetic capacity · 5 s metrics</span></span><div><button id="intro">Guide</button><button id="show-comparison" aria-expanded="false" aria-controls="comparison-panel">Compare</button><button id="show-diagnostics" aria-expanded="false" aria-controls="diagnostics">Console</button><button id="show-inspector" aria-expanded="false" aria-controls="inspector-panel">Inspector</button></div></div>
  </header>
  <aside class="traffic-panel overlay" aria-label="Traffic controls" data-scene-overlay>
    <div class="panel-heading"><h2>WORKLOAD</h2><span>seed <b id="seed-label">476</b></span></div>
    ${slider('rate', 'Requests /s', 30, 0, 500, '')}
    ${slider('slow', 'Slow requests', 0, 0, 100, '%')}
    <details id="workload-settings"><summary>Workload settings</summary><button id="close-workload">Return to map</button>${slider('slow-seconds', 'Sleep duration', 2, 0, 10, ' s', 0.5)}${slider('jitter', 'Arrival jitter', 15, 0, 50, '%')}
      <label for="seed" class="small">Workload seed</label><div class="button-row"><input id="seed" type="number" min="1" max="4294967295" value="476"><button id="new-seed">Apply seed</button></div>
      <label class="checkbox"><input type="checkbox" id="reduced-motion">Reduce motion</label><p class="small muted">Slow requests sleep without CPU or Redis work. The real per-client rate limiter is omitted in this capacity sandbox.</p>
    </details>
    <div class="inspect-picker"><label for="inspect-component">Inspect component</label><select id="inspect-component"><option value="">Select a component…</option></select></div>
    <p id="label-help" class="small muted">Select a building or its label to inspect.</p>
    <p id="feedback" class="feedback" role="status" aria-live="polite">Ready. Change the workload or select a component.</p>
  </aside>
  <aside id="inspector-panel" class="inspector overlay" aria-label="Component inspector" data-scene-overlay hidden><div class="panel-heading"><h2>INSPECTOR</h2><button data-reading aria-expanded="false">Read details</button><button id="close-inspector" aria-label="Close inspector">×</button></div><nav id="component-nav" class="component-nav" aria-label="Inspect a component"></nav><div id="inspector-body"></div></aside>

  <div class="scene-legend" aria-label="Scene legend" data-scene-overlay><span><i style="background:#287f83"></i>Active</span><span><i style="background:#b88029"></i>Queueing</span><span><i style="background:#7763a3"></i>Draining</span><span><i style="background:#a64a42"></i>Stopped</span><span>≤200 sampled flow markers</span><span id="render-rate"></span></div>
  <section id="experiment-panel" class="experiment-panel overlay" aria-label="Guided experiment" data-scene-overlay hidden><div><div class="panel-heading"><h2 id="experiment-title"></h2><button data-reading aria-expanded="false">Read details</button><button id="collapse-experiment" aria-label="Collapse experiment">×</button></div><p id="experiment-setup"></p><p id="experiment-goal"></p><p id="experiment-evidence"></p></div><div class="experiment-actions"><button id="experiment-action"></button><button id="experiment-reset">Reset experiment</button><button id="experiment-exit">Free running</button></div></section>
  <footer class="transport-bar" aria-label="Playback" data-scene-overlay>
    <div class="transport-controls"><button id="pause">Ⅱ Pause</button><button id="step">Step</button><label class="sr-only" for="speed">Playback speed</label><select id="speed"><option value="0.25">0.25×</option><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option><option value="4">4×</option></select><button id="reset">↻ Reset</button><button id="fresh-settings">Run current settings</button></div>
    <div class="transport-context"><label for="scenario">EXPERIMENT</label><select id="scenario"><option value="">Free running</option>${SCENARIOS.map(s => `<option value="${s.id}">${s.title}</option>`).join('')}</select><button id="show-experiment" aria-controls="experiment-panel" aria-expanded="false" hidden>Details</button><span id="metric-window">5 s rolling window</span></div><a href="${import.meta.env.BASE_URL}model.txt" target="_blank" rel="noreferrer">Model ${MODEL_VERSION} ↗</a>
  </footer>
  <section id="comparison-panel" class="comparison-panel overlay" aria-label="Baseline comparison" data-scene-overlay hidden></section>
  <section id="diagnostics" class="diagnostics overlay" aria-label="Simulation console" data-scene-overlay hidden><div class="panel-heading"><h2>CONSOLE</h2><button data-reading aria-expanded="false">Read details</button><button id="close-diagnostics" aria-label="Close console">×</button></div><div class="console-grid">
    <section><div class="card-header"><h2>Throughput</h2><span class="small muted">60 simulated seconds</span></div><svg id="chart" class="chart" viewBox="0 0 600 135" role="img" aria-label="Recent offered and successful throughput; current values appear in the top instruments."></svg><div class="chart-caption">— Offered &nbsp; — Successful</div></section>
    <section><div class="card-header"><h2>Request trace</h2><button id="latest-trace">Latest</button></div><div class="button-row"><label for="trace-id">Request</label><input id="trace-id" type="number" min="1" step="1" value="1"><button id="inspect-trace">Inspect</button><span id="trace-result" class="muted">Waiting for traffic</span></div><ol id="trace-list" class="trace-list"></ol></section>
  </div><details class="text-summary" open><summary>System summary & counters</summary><p id="summary"></p><div class="scroll-table"><table><caption class="sr-only">Replica state and request distribution</caption><thead><tr><th>Replica</th><th>State</th><th>CPU queue</th><th>Sleeping</th><th>Redis wait</th><th>Attempts</th><th>Local count</th></tr></thead><tbody id="replica-table"></tbody></table></div></details></section>
</div>
<dialog id="intro-dialog" aria-labelledby="intro-title"><div class="panel-heading"><h2 id="intro-title">OPERATING THE MODEL</h2></div><ol><li><strong>Set traffic.</strong> Requests enter through NGINX, reach a Go process, and use the shared Redis service.</li><li><strong>Select a component.</strong> Change capacity, stop a process, or interrupt Redis. Watch the queues and client outcomes.</li><li><strong>Inspect the evidence.</strong> The console shows individual request traces, counters, and throughput history.</li></ol><p>These are teaching values, not measurements of the real stack. The model never connects to Docker or production services. It is not an emulator or production monitor.</p><p class="guide-links"><a href="${import.meta.env.BASE_URL}model.txt" target="_blank" rel="noreferrer">Model assumptions</a> · <a href="${import.meta.env.BASE_URL}notices.txt" target="_blank" rel="noreferrer">Asset and dependency notices</a></p><button id="close-intro">Return to simulation</button></dialog>
`;

let experiment: Experiment | undefined;
let announcedCompletion = false;
let displayedExperiment: Experiment | undefined;
let engine = new Engine();
let initial: Config = { ...DEFAULT_CONFIG };
let initialCommands: Command[] = [];
let history = new MetricsHistory();
let snapshot = engine.snapshot();
let metrics = history.observe(snapshot);
let selected: ComponentId = 'nginx';
let trace: DeepReadonly<Trace> | undefined;
let selectedRequest = 1;
let pendingFeedback = false;
let pendingFeedbackTick = 0;
const pendingControls = new Map<string, number>();
let lastTopology = '';
const campus = new Campus();
const media = matchMedia('(prefers-reduced-motion: reduce)');
$('reduced-motion').toggleAttribute('checked', media.matches);
const clock = new Clock(() => {
  engine.step();
  if (engine.tick % 10 === 0) {
    snapshot = engine.snapshot(); metrics = history.observe(snapshot); update();
  }
});
clock.resume();
const comparison = new ComparisonPanel($('comparison-panel'), {
  prepare: baseline => {
    experiment = undefined;
    $<HTMLSelectElement>('scenario').value = '';
    reset(baseline.initialConfig, []);
    engine.replay(baseline.commands);
    snapshot = engine.snapshot(); update();
  },
  pause: () => clock.pause(),
  feedback,
});

function feedback(message: string): void { $('feedback').textContent = message; }
function issue(command: Command): void {
  try {
    engine.command(command);
    pendingFeedback = true; pendingFeedbackTick = engine.tick + 1;
    feedback(clock.paused ? 'Change queued. Step or resume to apply it at the next boundary.' : 'Change queued for the next simulation boundary.');
  } catch (error) { feedback(String(error).replace('Error: ', '')); }
}

function select(id: ComponentId): void {
  selected = id; $('inspector-panel').hidden = false; $('show-inspector').setAttribute('aria-expanded', 'true');
  renderInspector(); update();
}

function renderInspector(): void {
  const b = snapshot.backends.find(b => `app${b.id}` === selected);
  let body = '';
  if (b) body = `<h2>app${b.id}</h2><p class="panel-intro">An identical Go process. Local memory belongs to this incarnation.</p><span class="badge" id="component-state"></span><dl id="component-stats"></dl>
    ${slider('capacity', 'CPU capacity', b.capacity, 5, 200, ' /s', 5, 'CPU work units/s. A root costs 1; a slow request costs 0.1 plus sleep.')}
    <div class="button-row"><button data-action="stop" class="danger">Stop now</button><button data-action="restart">Restart</button><button data-action="drain">Drain</button></div>
    <details><summary>Advanced backend</summary>${slider('admission', 'In-flight limit', b.inFlightLimit, 1, 256, '', 1, 'Synthetic admission cap; lowering it preserves existing work.')}<button data-action="remove" class="danger">Drain & remove</button><p class="small muted" style="margin-top:8px">Keep at least one building; stop it for a total outage.</p></details>`;
  else if (selected === 'redis') body = `<h2>Redis</h2><p class="panel-intro">One shared execution queue. Every successful root sends INCR, then PUBLISH.</p><span class="badge" id="component-state"></span><dl id="component-stats"></dl><label class="checkbox"><input type="checkbox" id="redis-online" ${snapshot.config.redisOnline ? 'checked' : ''}>Redis online</label>
    ${slider('redis-incr', 'INCR processing', snapshot.config.redisIncrMs, 0.1, 100, ' ms', 0.1)}
    ${slider('redis-rtt', 'Network round trip', snapshot.config.redisRttMs, 0, 2000, ' ms', 1, 'Travel time overlaps across requests; it does not consume execution capacity.')}
    <details><summary>Advanced Redis</summary>${slider('redis-publish', 'PUBLISH processing', snapshot.config.redisPublishMs, 0.1, 100, ' ms', 0.1)}<p class="small muted">Offline retains committed data. Accepted commands may outlive their caller.</p></details>`;
  else if (selected === 'clients') body = `<h2>Visitors</h2><p class="panel-intro">A repeatable offered workload. Capacity and retries never change its random stream.</p><span class="badge" id="component-state"></span><dl id="component-stats"></dl><p class="small muted">Use the always-visible traffic controls to change new arrivals. Slow requests release CPU while sleeping.</p><button id="run-settings" style="margin-top:20px">Run with these settings</button>`;
  else body = `<h2>NGINX</h2><p class="panel-intro">Round-robin dispatch. A failed attempt can try another eligible backend.</p><span class="badge" id="component-state"></span><dl id="component-stats"></dl><label class="checkbox"><input type="checkbox" id="retry" ${snapshot.config.retry ? 'checked' : ''}>Retry eligible failures</label><p class="small muted">Up to three total attempts. Redis-error HTTP 500s are not retried.</p><button id="add-backend" class="primary" style="width:100%;margin-top:20px">+ Add backend</button><p id="replica-limit" class="small muted" style="margin-top:8px"></p><button id="run-settings" style="margin-top:18px;width:100%">Run with these settings</button>`;
  $('inspector-body').innerHTML = body;
}

function updateInspector(): void {
  const b = snapshot.backends.find(b => `app${b.id}` === selected);
  let state = '', rows: [string, string][] = [];
  if (b) {
    state = `${backendState(b)} · process ${b.incarnation}`;
    rows = [['In flight', String(b.inFlight)], ['CPU queue', String(b.cpuQueue)], ['Sleeping / Redis', `${b.sleeping} / ${b.redisWaiting}`], ['Local counter', number(b.localCount)], ['Proxy eligibility', b.withdrawn ? 'Withdrawn' : b.excludedUntil > snapshot.now && snapshot.backends.length > 1 ? 'Excluded' : 'Eligible']];
    $('inspector-body').querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
      const action = button.dataset.action;
      button.disabled = (action === 'stop' && b.state === 'stopped') || (action === 'drain' && (b.state === 'draining' || b.state === 'stopped')) || (action === 'remove' && (snapshot.backends.filter(b => !b.removing).length <= 1 || b.removing)) || (action === 'restart' && b.removing);
    });
  } else if (selected === 'redis') {
    state = snapshot.redis.online ? snapshot.redis.active ? 'Busy' : 'Idle' : 'Offline · data retained';
    rows = [['Global counter', number(snapshot.totals.globalCount)], ['Execution queue', number(snapshot.redis.queue)], ['Outstanding operations', number(snapshot.redis.operations)], ['Detached from caller', number(snapshot.redis.detached)], ['Publish failures', number(snapshot.totals.publishFailures)]];
  } else if (selected === 'clients') {
    state = `${number(snapshot.totals.offered)} offered since reset`;
    rows = [['Succeeded', number(snapshot.totals.succeeded)], ['Failed', number(snapshot.totals.failed)], ['Still in flight', number(snapshot.requests.length)], ['Model admissions rejected', number(snapshot.totals.rejected)]];
  } else {
    state = `${snapshot.backends.length} backends · round robin`;
    rows = [['Backend attempts', number(snapshot.totals.attempts)], ['Retry decisions', number(snapshot.totals.retried)], ['Failed clients', number(snapshot.totals.failed)]];
    $<HTMLButtonElement>('add-backend').disabled = snapshot.backends.length >= 8;
    $('replica-limit').textContent = `${snapshot.backends.length} of 8 buildings. Remove through a backend inspector.`;
  }
  $('component-state').textContent = state;
  $('component-stats').innerHTML = rows.map(([key, value]) => `<dt>${key}</dt><dd>${value}</dd>`).join('');
}

function updateMetrics(m: Metrics): void {
  const values: Record<string, string> = {
    throughput: number(m.successRate, 1), offered: number(m.offeredRate, 1), errors: m.errorFraction === null ? '—' : number(m.errorFraction * 100, 1),
    p95: m.p95Ms === null ? '—' : number(m.p95Ms, 1), average: m.averageMs === null ? '—' : number(m.averageMs, 1),
    pending: number(m.pending), oldest: number(m.oldestMs), queue: number(m.queue), cpu: number(m.cpuUtilization * 100, 1),
    'redis-util': number(m.redisUtilization * 100, 1), global: number(snapshot.totals.globalCount), 'sample-count': number(m.samples),
  };
  for (const [id, value] of Object.entries(values)) $(id).textContent = value;
  $('metric-window').textContent = `${number(m.windowSeconds, 1)} s rolling window · modeled`;
  const points = history.points;
  const max = Math.max(1, ...points.map(p => Math.max(p.metrics.offeredRate, p.metrics.successRate)));
  const end = snapshot.now / 1_000_000;
  const path = (key: 'offeredRate' | 'successRate') => points.map((p, i) => `${i ? 'L' : 'M'}${(25 + (p.time / 1_000_000 - Math.max(0, end - 60)) / 60 * 565).toFixed(1)},${(115 - p.metrics[key] / max * 95).toFixed(1)}`).join(' ');
  $('chart').innerHTML = `<path d="M25 20H590M25 67H590M25 115H590" stroke="#e1e7dc" fill="none"/><text x="0" y="22" fill="#61766d" font-size="10">${Math.round(max)}</text><text x="10" y="117" fill="#61766d" font-size="10">0</text><path d="${path('offeredRate')}" stroke="#94a39a" stroke-dasharray="4 4" stroke-width="2" fill="none"/><path d="${path('successRate')}" stroke="#276e59" stroke-width="2.5" fill="none"/>`;
}

function updateTrace(): void {
  const fresh = snapshot.traces.find(t => t.id === selectedRequest);
  if (fresh) { trace = fresh; engine.pinTrace(selectedRequest); }
  if (!trace || trace.id !== selectedRequest) {
    $('trace-result').textContent = 'Not in the recent trace buffer'; $('trace-list').innerHTML = ''; return;
  }
  $('trace-result').textContent = `${trace.route === 'root' ? 'GET /' : 'GET /slow'} · ${trace.outcome ?? 'in flight'}`;
  $('trace-list').innerHTML = trace.events.map(e => `<li><time>${((e.at - trace!.startedAt) / 1000).toFixed(1)} ms</time>${escape(e.message)}</li>`).join('');
}

function updateExperiment(): void {
  if (displayedExperiment !== experiment) {
    $('experiment-panel').hidden = !experiment; displayedExperiment = experiment;
    $('show-experiment').setAttribute('aria-expanded', String(!!experiment));
  }
  if ($('show-experiment').hidden !== !experiment) $('show-experiment').hidden = !experiment;
  document.body.classList.toggle('in-experiment', !!experiment && !$('experiment-panel').hidden);
  if (!experiment) return;
  const progress = experiment.observe(snapshot, metrics);
  $('experiment-title').textContent = `${experiment.definition.title}${progress.complete ? ' · Verified' : ''}`;
  $('experiment-setup').textContent = experiment.definition.setup;
  $('experiment-goal').textContent = progress.message;
  $('experiment-evidence').textContent = progress.evidence;
  $('experiment-action').textContent = experiment.definition.action;
  $<HTMLButtonElement>('experiment-action').disabled = !progress.canAct;
  if (progress.complete && !announcedCompletion) { announcedCompletion = true; feedback(`Experiment complete. ${progress.evidence}`); }
}

function startExperiment(id: ScenarioId): void {
  experiment = new Experiment(id); announcedCompletion = false;
  reset({ ...DEFAULT_CONFIG, ...experiment.definition.config }, [], true);
  $<HTMLSelectElement>('scenario').value = id;
}

function syncControls(): void {
  const b = snapshot.backends.find(b => `app${b.id}` === selected);
  const values: Record<string, [number, string]> = {
    rate: [snapshot.config.rate, ''], slow: [snapshot.config.slowPercent, '%'],
    'slow-seconds': [snapshot.config.slowSeconds, ' s'], jitter: [snapshot.config.jitter * 100, '%'],
    'redis-incr': [snapshot.config.redisIncrMs, ' ms'], 'redis-publish': [snapshot.config.redisPublishMs, ' ms'],
    'redis-rtt': [snapshot.config.redisRttMs, ' ms'],
  };
  if (b) { values.capacity = [b.capacity, ' /s']; values.admission = [b.inFlightLimit, '']; }
  for (const [id, [value, unit]] of Object.entries(values)) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input || (pendingControls.get(id) ?? 0) > snapshot.tick || document.activeElement === input) continue;
    input.value = String(value); $(`${id}-value`).textContent = `${value}${unit}`;
    pendingControls.delete(id);
  }
  for (const [id, value] of [['retry', snapshot.config.retry], ['redis-online', snapshot.config.redisOnline]] as const) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (input && (pendingControls.get(id) ?? 0) <= snapshot.tick) input.checked = value;
  }
}

function update(): void {
  comparison.observe(snapshot);
  if (pendingFeedback && snapshot.tick >= pendingFeedbackTick) {
    pendingFeedback = false;
    const rejected = snapshot.commands.find(c => c.tick === pendingFeedbackTick && c.applied === false);
    feedback(rejected ? `Change rejected: ${rejected.error}` : 'Change applied. Watch the queues, outcomes, and counters.');
  }
  if (selected.startsWith('app') && !snapshot.backends.some(b => `app${b.id}` === selected)) { selected = 'nginx'; renderInspector(); }
  const topology = snapshot.backends.map(b => b.id).join(',');
  if (topology !== lastTopology) {
    lastTopology = topology;
    const ids: ComponentId[] = ['clients', 'nginx', ...snapshot.backends.map(b => `app${b.id}` as const), 'redis'];
    $<HTMLSelectElement>('inspect-component').innerHTML = '<option value="">Select a component…</option>' + ids.map(id => `<option value="${id}">${id === 'clients' ? 'Clients' : id === 'nginx' ? 'NGINX' : id === 'redis' ? 'Redis' : id}</option>`).join('');
    $('component-nav').innerHTML = ids.map(id => `<button data-component="${id}" aria-pressed="${id === selected}">${id === 'clients' ? 'Visitors' : id === 'nginx' ? 'NGINX' : id === 'redis' ? 'Redis' : id}</button>`).join('');
  }
  $('component-nav').querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.component === selected)));
  updateInspector(); syncControls();
  $('sim-time').textContent = `${(snapshot.now / 1_000_000).toFixed(2)} s`;
  $('seed-label').textContent = String(snapshot.config.seed);
  $('pause').textContent = clock.paused ? '▶ Resume' : 'Ⅱ Pause';
  $('playback-state').textContent = clock.paused ? 'Paused' : 'Running';
  $<HTMLButtonElement>('step').disabled = !clock.paused;
  $('summary').textContent = `Visitors → NGINX → ${snapshot.backends.length} backends → Redis. ${snapshot.backends.filter(b => b.state === 'running').length} processes running; ${snapshot.backends.filter(b => b.state === 'stopped').length} stopped; ${snapshot.backends.filter(b => b.state === 'draining').length} draining. Redis ${snapshot.redis.online ? 'online' : 'offline'}. ${metrics.queue} queued, ${metrics.pending} in flight. Success ${number(metrics.successRate, 1)}/s; ${metrics.errorFraction === null ? 'no completed samples' : number(metrics.errorFraction * 100, 1) + '% failures'}. Global count ${snapshot.totals.globalCount}; lifetime local entries ${snapshot.totals.localEntries}.`;
  $('replica-table').innerHTML = snapshot.backends.map(b => `<tr><th scope="row">app${b.id}</th><td>${backendState(b)}</td><td>${b.cpuQueue}</td><td>${b.sleeping}</td><td>${b.redisWaiting}</td><td>${b.attempts}</td><td>${b.localCount}</td></tr>`).join('');
  updateMetrics(metrics); updateTrace(); updateExperiment();
  campus.update(snapshot, selected, $<HTMLInputElement>('reduced-motion').checked);
  campus.render();
}

function reset(config = initial, commands = initialCommands, running = false): void {
  const next = new Engine(config);
  for (const command of commands) next.command(command);
  initial = { ...config }; initialCommands = structuredClone(commands);
  engine = next; pendingFeedback = false; pendingControls.clear();
  history = new MetricsHistory(); clock.reset(); comparison.reset();
  if (running) clock.resume();
  snapshot = engine.snapshot(); metrics = history.observe(snapshot); trace = undefined; selectedRequest = 1;
  $<HTMLInputElement>('trace-id').value = '1';
  for (const [id, value] of Object.entries({ rate: config.rate, slow: config.slowPercent, 'slow-seconds': config.slowSeconds, jitter: config.jitter * 100, seed: config.seed })) {
    $<HTMLInputElement>(id).value = String(value);
    const output = document.getElementById(`${id}-value`);
    if (output) output.textContent = `${value}${id === 'rate' ? ' /s' : id === 'slow-seconds' ? ' s' : '%'}`;
  }
  renderInspector(); update(); feedback('Fresh experiment. Queues and counters cleared; the workload seed is preserved.');
}

function runWithSettings(): void {
  snapshot = engine.snapshot();
  if (snapshot.pendingCommands) { feedback('Step or resume to apply queued changes before starting a fresh run.'); return; }
  const config = { ...snapshot.config };
  const commands: Command[] = [];
  snapshot.backends.forEach((b, i) => {
    commands.push({ type: 'capacity', backend: i + 1, value: b.capacity }, { type: 'admission', backend: i + 1, value: b.inFlightLimit });
    if (b.state === 'stopped' || b.state === 'draining') commands.push({ type: 'stop', backend: i + 1 });
  });
  experiment = undefined; $<HTMLSelectElement>('scenario').value = '';
  reset(config, commands, true);
}

$('app').addEventListener('click', event => {
  const target = (event.target as HTMLElement).closest('button');
  if (!target) return;
  if (target.dataset.component) { select(target.dataset.component as ComponentId); return; }
  if (target.dataset.action && selected.startsWith('app')) {
    issue({ type: target.dataset.action as 'stop' | 'restart' | 'drain' | 'remove', backend: Number(selected.slice(3)) }); return;
  }
  switch (target.id) {
    case 'pause': clock.paused ? clock.resume() : clock.pause(); snapshot = engine.snapshot(); metrics = history.observe(snapshot); update(); break;
    case 'close-workload': $<HTMLDetailsElement>('workload-settings').open = false; $('workload-settings').querySelector('summary')!.focus(); break;
    case 'step': clock.step(); snapshot = engine.snapshot(); metrics = history.observe(snapshot); update(); break;
    case 'reset': if (experiment) startExperiment(experiment.definition.id); else reset(); break;
    case 'experiment-action': if (experiment) for (const command of experiment.actions(snapshot)) issue(command); break;
    case 'experiment-reset': if (experiment) startExperiment(experiment.definition.id); break;
    case 'experiment-exit': experiment = undefined; $<HTMLSelectElement>('scenario').value = ''; update(); break;
    case 'run-settings': case 'fresh-settings': runWithSettings(); break;
    case 'show-comparison': comparison.toggle(); break;
    case 'show-experiment': $('experiment-panel').hidden = !$('experiment-panel').hidden; target.setAttribute('aria-expanded', String(!$('experiment-panel').hidden)); break;
    case 'collapse-experiment': $('experiment-panel').hidden = true; $('show-experiment').setAttribute('aria-expanded', 'false'); $('show-experiment').focus(); break;
    case 'show-inspector': $('inspector-panel').hidden = !$('inspector-panel').hidden; target.setAttribute('aria-expanded', String(!$('inspector-panel').hidden)); break;
    case 'close-inspector': $('inspector-panel').hidden = true; $('show-inspector').setAttribute('aria-expanded', 'false'); $('show-inspector').focus(); break;
    case 'show-diagnostics': $('diagnostics').hidden = !$('diagnostics').hidden; target.setAttribute('aria-expanded', String(!$('diagnostics').hidden)); break;
    case 'close-diagnostics': $('diagnostics').hidden = true; $('show-diagnostics').setAttribute('aria-expanded', 'false'); $('show-diagnostics').focus(); break;
    case 'new-seed': {
      const seed = Number($<HTMLInputElement>('seed').value);
      try {
        reset({ ...initial, seed }, initialCommands);
        experiment = undefined; $<HTMLSelectElement>('scenario').value = ''; update();
      } catch (error) { feedback(String(error)); }
      break;
    }
    case 'add-backend': issue({ type: 'add' }); break;
    case 'latest-trace': selectedRequest = snapshot.traces.reduce((latest, trace) => Math.max(latest, trace.id), 1); $<HTMLInputElement>('trace-id').value = String(selectedRequest); updateTrace(); break;
    case 'inspect-trace': selectedRequest = Number($<HTMLInputElement>('trace-id').value); updateTrace(); break;
    case 'intro': introWasRunning = !clock.paused; clock.pause(); update(); $<HTMLDialogElement>('intro-dialog').showModal(); break;
  }
});

$('app').addEventListener('input', event => {
  const input = event.target as HTMLInputElement;
  if (input.type !== 'range') return;
  const value = Number(input.value);
  pendingControls.set(input.id, engine.tick + 1);
  const units: Record<string, string> = { rate: ' /s', slow: '%', 'slow-seconds': ' s', jitter: '%', capacity: ' /s', admission: '', 'redis-incr': ' ms', 'redis-publish': ' ms', 'redis-rtt': ' ms' };
  $(`${input.id}-value`).textContent = `${value}${units[input.id] ?? ''}`;
  const backend = Number(selected.slice(3));
  switch (input.id) {
    case 'rate': issue({ type: 'traffic', rate: value }); break;
    case 'slow': issue({ type: 'traffic', slowPercent: value }); break;
    case 'slow-seconds': issue({ type: 'traffic', slowSeconds: value }); break;
    case 'jitter': issue({ type: 'traffic', jitter: value / 100 }); break;
    case 'capacity': issue({ type: 'capacity', backend, value }); break;
    case 'admission': issue({ type: 'admission', backend, value }); break;
    case 'redis-incr': issue({ type: 'redis', incrMs: value }); break;
    case 'redis-publish': issue({ type: 'redis', publishMs: value }); break;
    case 'redis-rtt': issue({ type: 'redis', rttMs: value }); break;
  }
});
$('app').addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.type === 'checkbox') pendingControls.set(input.id, engine.tick + 1);
  switch (input.id) {
    case 'scenario': if (input.value) startExperiment(input.value as ScenarioId); else { experiment = undefined; update(); } break;
    case 'inspect-component': if (input.value) select(input.value as ComponentId); break;
    case 'retry': issue({ type: 'retry', enabled: input.checked }); break;
    case 'redis-online': issue({ type: 'redis', online: input.checked }); break;
    case 'speed': clock.setSpeed(Number(input.value)); break;
    case 'reduced-motion': update(); break;
  }
});
let introWasRunning = false;
$('close-intro').addEventListener('click', () => $<HTMLDialogElement>('intro-dialog').close());
$('intro-dialog').addEventListener('close', () => { if (introWasRunning) clock.resume(); update(); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { clock.pause(); update(); feedback('Paused while this tab was hidden. Resume when ready.'); }
});
media.addEventListener('change', () => { $<HTMLInputElement>('reduced-motion').checked = media.matches; update(); });

renderInspector();
$('app').dataset.ready = 'loading';
try {
  await campus.mount($('campus'), select, id => {
    selectedRequest = id; $<HTMLInputElement>('trace-id').value = String(id); updateTrace();
    $('diagnostics').hidden = false; $('show-diagnostics').setAttribute('aria-expanded', 'true');
  });
  update();
  $('app').dataset.ready = 'ready';
} catch (error) {
  $('campus').innerHTML = '<p style="padding:30px">The visual campus could not start. All controls, metrics, and the system summary below remain available.</p>';
  console.error(error);
  $('app').dataset.ready = 'fallback';
}
update();
let previous: number | undefined;
let frameWindow = 0, frames = 0;
let catchingUp = false;
function frame(now: number): void {
  const elapsed = previous === undefined ? 0 : now - previous; previous = now;
  frameWindow += elapsed; frames++;
  if (frameWindow >= 1000) {
    $('render-rate').textContent = `${Math.round(frames * 1000 / frameWindow)} fps`;
    frameWindow = 0; frames = 0;
  }
  const result = clock.consume(elapsed, 20);
  if (result.behind && !clock.paused) feedback('Playback is catching up. All modeled requests are retained.');
  else if (catchingUp && $('feedback').textContent?.startsWith('Playback is catching up.')) feedback('Playback has caught up.');
  catchingUp = result.behind && !clock.paused;
  campus.render(engine.now + (clock.paused ? 0 : clock.interpolationUs));
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
