import { RunRecorder, compareRuns, OBSERVATION } from '../metrics/comparison';
import type { RecordedRun, RunValues } from '../metrics/comparison';
import type { Snapshot } from '../model/types';

const labels: [keyof RunValues, string, number, string][] = [
  ['successRate', 'Successful throughput', 1, '/s'], ['failed', 'Failed requests', 0, ''],
  ['completed', 'Completed samples', 0, ''], ['averageMs', 'Average latency', 1, 'ms'],
  ['p95Ms', 'p95 latency', 1, 'ms'], ['averageQueue', 'Time-weighted queue', 1, ''],
  ['peakSampledQueue', 'Peak observed queue', 0, ''], ['pending', 'Pending at end', 0, ''],
  ['oldestMs', 'Oldest pending', 1, 'ms'], ['cpuUtilization', 'Backend CPU utilization', 1, '%'],
  ['redisUtilization', 'Redis utilization', 1, '%'], ['localIncrements', 'Local increments', 0, ''],
  ['globalIncrements', 'Global increments', 0, ''],
];
const escape = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const format = (value: number | null, digits: number, unit: string) => value === null ? 'No samples' : `${(unit === '%' ? value * 100 : value).toFixed(digits)}${unit ? ` ${unit}` : ''}`;

export class ComparisonPanel {
  private recorder = new RunRecorder();
  private baseline?: RecordedRun;
  private candidate?: RecordedRun;
  private recordingBaseline = false;
  private runningCandidate = false;
  private snapshot?: Snapshot;
  private status = 'One baseline per session. Observe seconds 5–20; seconds 0–5 are warmup.';

  constructor(private root: HTMLElement, private hooks: {
    prepare: (baseline: RecordedRun) => void;
    pause: () => void;
    feedback: (message: string) => void;
  }) {
    root.innerHTML = `<div class="panel-heading"><h2>COMPARE RUNS</h2><button data-compare="close" aria-label="Close comparison">×</button></div>
      <p class="comparison-intro">Save one complete run. Replay its workload and interventions, change an operating setting, then compare the same 15-second window.</p>
      <p id="comparison-status" role="status"></p>
      <div class="comparison-actions"><button data-compare="save">Save baseline</button><button data-compare="replace" hidden>Replace baseline</button><button data-compare="prepare" disabled>Prepare candidate</button><button data-compare="clear" disabled>Clear baseline</button></div>
      <p id="comparison-context" class="small muted"></p><div id="comparison-result"></div>
      <p class="comparison-note">Warmup: 0–5 s. Measurement: 5–20 s. Latency includes all requests completed inside that window, including failures. Pending requests are reported separately. Peak queue is sampled every 200 ms. Utilization changes are percentage points. The baseline survives reset and is cleared on page reload.</p>`;
    root.addEventListener('click', event => {
      const action = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-compare]')?.dataset.compare;
      switch (action) {
        case 'close': this.toggle(false); document.getElementById('show-comparison')?.focus(); break;
        case 'save': case 'replace': this.recordingBaseline = true; this.captureBaseline(); break;
        case 'clear': this.baseline = undefined; this.candidate = undefined; this.recordingBaseline = false; this.runningCandidate = false; this.status = 'Baseline cleared.'; break;
        case 'prepare':
          if (this.baseline) {
            this.hooks.prepare(this.baseline);
            this.runningCandidate = true;
            this.candidate = undefined;
            this.status = 'Candidate prepared at time zero. Change component settings, then Resume. Common interventions will replay at their original times.';
          }
          break;
      }
      this.render();
    });
  }

  toggle(open = this.root.hidden): void {
    this.root.hidden = !open;
    document.getElementById('show-comparison')?.setAttribute('aria-expanded', String(open));
    this.render();
  }

  reset(): void {
    this.recorder = new RunRecorder(); this.candidate = undefined;
    this.recordingBaseline = false; this.runningCandidate = false;
    this.status = this.baseline ? 'Baseline retained. Record a new run or prepare a candidate.' : 'Observe seconds 5–20; seconds 0–5 are warmup.';
  }

  observe(snapshot: Snapshot): void {
    this.snapshot = snapshot;
    this.recorder.observe(snapshot);
    if (this.recordingBaseline) this.captureBaseline();
    if (this.runningCandidate && this.recorder.result) {
      this.candidate = this.recorder.result;
      this.runningCandidate = false;
      this.hooks.pause();
      this.status = this.baseline ? compareRuns(this.baseline, this.candidate).reason : 'Baseline unavailable.';
      this.hooks.feedback('Candidate reached 20 seconds. Open Compare for the matched-window result.');
    }
    if (!this.root.hidden) this.render();
  }

  private captureBaseline(): void {
    if (!this.recorder.result) { this.status = `Recording baseline: ${((this.snapshot?.now ?? 0) / 1_000_000).toFixed(1)} / 20 s. Resume playback to finish.`; return; }
    this.recordingBaseline = false;
    if (this.recorder.result.invalidReason) { this.status = this.recorder.result.invalidReason; return; }
    this.baseline = structuredClone(this.recorder.result);
    this.candidate = undefined; this.runningCandidate = false;
    this.status = 'Baseline saved: seconds 5–20 of this run. Changes after 20 s are outside the saved window.';
    this.hooks.feedback('Baseline saved. Prepare a candidate to change a setting against the same workload.');
  }

  private render(): void {
    const get = (selector: string) => this.root.querySelector<HTMLElement>(selector)!;
    get('#comparison-status').textContent = this.status;
    get('[data-compare=save]').hidden = !!this.baseline;
    get('[data-compare=replace]').hidden = !this.baseline;
    (get('[data-compare=prepare]') as HTMLButtonElement).disabled = !this.baseline;
    (get('[data-compare=clear]') as HTMLButtonElement).disabled = !this.baseline;
    get('#comparison-context').textContent = this.baseline ? `Saved model ${this.baseline.version} · seed ${this.baseline.seed} · ${(OBSERVATION.end - OBSERVATION.start) / 1_000_000} s measurement · ${this.baseline.values.completed} completed samples · ${this.baseline.commands.length} interventions` : 'No saved baseline.';
    const result = get('#comparison-result');
    if (!this.baseline || !this.candidate) { result.innerHTML = ''; return; }
    const comparison = compareRuns(this.baseline, this.candidate);
    const changes = comparison.changes.length ? `<ul>${comparison.changes.slice(0, 20).map(c => `<li>${escape(c)}</li>`).join('')}</ul>${comparison.changes.length > 20 ? `<p>${comparison.changes.length - 20} more recorded differences.</p>` : ''}` : '<p>Identical settings and interventions.</p>';
    if (!comparison.comparable) { result.innerHTML = `<p class="comparison-error">Not comparable: ${escape(comparison.reason)}</p>${changes}`; return; }
    result.innerHTML = `<div class="scroll-table"><table><thead><tr><th>Measurement</th><th>Baseline</th><th>Candidate</th><th>Change</th></tr></thead><tbody>${labels.map(([key, label, digits, unit]) => `<tr><th scope="row">${label}</th><td>${format(this.baseline!.values[key], digits, unit)}</td><td>${format(this.candidate!.values[key], digits, unit)}</td><td>${format(comparison.delta![key], digits, unit === '%' ? '%' : unit)}</td></tr>`).join('')}</tbody></table></div><details><summary>Changed settings and interventions (${comparison.changes.length})</summary>${changes}</details>`;
  }
}
