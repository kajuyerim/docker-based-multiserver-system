import type { Snapshot } from '../model/types';
import { TraceCursor, pressure } from '../view/request-view';
import type { RequestView } from '../view/request-view';

export class RequestPanel {
  readonly cursor = new TraceCursor();
  private renderedId?: number;
  private rows = new Map<number, HTMLButtonElement>();
  constructor(private root: HTMLElement) {}

  reset(): void {
    this.cursor.select(1); this.cursor.following = false;
    this.renderedId = undefined; this.rows.clear();
    this.root.querySelector('#trace-list')!.replaceChildren();
  }

  update(snapshot: Snapshot): RequestView | undefined {
    this.cursor.observe(snapshot);
    const trace = this.cursor.trace, view = this.cursor.view(snapshot);
    const get = <T extends HTMLElement = HTMLElement>(id: string) => this.root.querySelector<T>(`#${id}`)!;
    get('trace-result').textContent = trace ? `${trace.route === 'root' ? 'GET /' : 'GET /slow'} · ${trace.outcome ?? 'in flight'}` : 'Not in the recent trace buffer; history is unavailable.';
    get('follow-request').setAttribute('aria-pressed', String(this.cursor.following));
    get('follow-request').textContent = this.cursor.following ? 'Stop following' : 'Follow request';
    get<HTMLButtonElement>('trace-previous').disabled = !view || view.index === 0;
    get<HTMLButtonElement>('trace-next').disabled = !view || view.index === view.total - 1;
    get<HTMLButtonElement>('trace-latest-event').disabled = !view;
    get('trace-latest-event').setAttribute('aria-pressed', String(this.cursor.sequence === undefined));
    get<HTMLButtonElement>('trace-component').disabled = !view?.component;
    get('trace-evidence').hidden = !view;
    if (view && trace) {
      get('trace-event-title').textContent = `${view.index + 1}/${view.total} · ${view.title}`;
      get('trace-event-identity').textContent = view.identity;
      get('trace-event-time').textContent = `Historical event at ${(view.event.at / 1_000_000).toFixed(3)} s (+${((view.event.at - trace.startedAt) / 1000).toFixed(1)} ms from request creation). Current system: ${(snapshot.now / 1_000_000).toFixed(2)} s. Queues and counters are not rewound.`;
      get('trace-event-explanation').textContent = view.explanation;
      get('trace-event-location').textContent = view.locationNote;
      get('trace-current-pressure').textContent = view.component ? `Current ${view.component}: ${pressure(snapshot, view.component).map(([name, value]) => `${name} ${value}`).join(' · ')}. Exact current counts, not historical occupancy.` : 'Historical process unavailable in the current topology.';
    }
    get('trace-retention').textContent = trace?.omittedEvents ? `${trace.omittedEvents} later events omitted by the 64-event trace limit; the displayed sequence is incomplete.` : 'Up to 64 recorded events per trace; one selected trace is retained beyond the recent 100-request buffer. Follow path is separate from the 200 background markers.';
    if (this.renderedId !== trace?.id) {
      get('trace-list').replaceChildren(); this.rows.clear(); this.renderedId = trace?.id;
    }
    for (const event of trace?.events ?? []) {
      let button = this.rows.get(event.sequence);
      if (!button) {
        const row = document.createElement('li');
        button = document.createElement('button'); button.dataset.traceEvent = String(event.sequence);
        const time = document.createElement('time'); time.textContent = `${((event.at - trace!.startedAt) / 1000).toFixed(1)} ms`;
        button.append(time, document.createTextNode(event.message)); row.append(button); get('trace-list').append(row);
        this.rows.set(event.sequence, button);
      }
      button.setAttribute('aria-pressed', String(event.sequence === view?.event.sequence));
    }
    return view;
  }
}
