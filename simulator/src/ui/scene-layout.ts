import { usableScene } from '../view/layout';
import type { Rect } from '../view/layout';

const sheets = ['inspector-panel', 'diagnostics', 'comparison-panel', 'experiment-panel'];

export class SceneLayout {
  private resize: ResizeObserver;
  private mutations: MutationObserver;
  private frame = 0;
  private currentSheet?: HTMLElement;
  private reading = false;
  private previous = '';
  private elements: HTMLElement[];

  constructor(private host: HTMLElement, private onArea: (area: Rect) => void) {
    this.elements = [...document.querySelectorAll<HTMLElement>('[data-scene-overlay]')];
    this.resize = new ResizeObserver(this.schedule);
    this.resize.observe(host);
    for (const element of this.elements) this.resize.observe(element);
    this.mutations = new MutationObserver(records => {
      for (const record of records) {
        const target = record.target as HTMLElement;
        if (record.attributeName === 'hidden' && sheets.includes(target.id) && !target.hidden) this.activate(target);
      }
      this.schedule();
    });
    this.mutations.observe(document.getElementById('app')!, { subtree: true, attributes: true, attributeFilter: ['hidden', 'open'] });
    document.addEventListener('click', this.click);
    document.addEventListener('keydown', this.keydown);
    this.schedule();
  }

  private activate(target: HTMLElement): void {
    if (matchMedia('(max-width: 1024px)').matches) document.querySelector<HTMLDetailsElement>('#workload-settings')!.open = false;
    this.currentSheet = target;
    this.reading = false;
    document.body.classList.remove('reading-panel');
    document.querySelectorAll<HTMLButtonElement>('[data-reading]').forEach(button => {
      button.textContent = 'Read details'; button.setAttribute('aria-expanded', 'false');
    });
    for (const id of sheets) {
      const other = document.getElementById(id)!;
      if (other !== target && !other.hidden) {
        other.hidden = true;
        document.querySelector(`[aria-controls="${id}"]`)?.setAttribute('aria-expanded', 'false');
      }
    }
  }

  private click = (event: MouseEvent): void => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-reading]');
    if (!button) return;
    this.reading = !this.reading;
    document.body.classList.toggle('reading-panel', this.reading);
    button.textContent = this.reading ? 'Return to map' : 'Read details';
    button.setAttribute('aria-expanded', String(this.reading));
    this.schedule();
  };

  private keydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape') return;
    const workload = document.querySelector<HTMLDetailsElement>('#workload-settings')!;
    if (workload.open && matchMedia('(max-width: 1024px)').matches) {
      workload.open = false;
      workload.querySelector('summary')!.focus();
    } else if (this.reading) {
      this.currentSheet?.querySelector<HTMLButtonElement>('[data-reading]')?.click();
      this.currentSheet?.querySelector<HTMLButtonElement>('[data-reading]')?.focus();
    }
  };

  private schedule = (): void => {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.measure(); });
  };

  private measure(): void {
    const width = this.host.clientWidth, height = this.host.clientHeight;
    const header = document.querySelector<HTMLElement>('.instrument-bar')!.getBoundingClientRect();
    const traffic = document.querySelector<HTMLElement>('.traffic-panel')!;
    const footer = document.querySelector<HTMLElement>('.transport-bar')!.getBoundingClientRect();
    document.documentElement.style.setProperty('--hud-bottom', `${header.bottom + 8}px`);
    document.documentElement.style.setProperty('--transport-height', `${height - footer.top}px`);
    document.body.classList.toggle('reading-workload', !!document.querySelector('#workload-settings[open]'));
    const trafficBottom = traffic.getBoundingClientRect().bottom;
    document.documentElement.style.setProperty('--traffic-bottom', `${trafficBottom + 8}px`);
    const halfViewportHeight = width * height / (2 * Math.max(1, width - 16));
    const sheetHeight = Math.max(64, height - halfViewportHeight - trafficBottom - (height - footer.top) - 24);
    document.documentElement.style.setProperty('--sheet-height', `${sheetHeight}px`);
    if (this.currentSheet?.hidden) {
      this.reading = false;
      document.body.classList.remove('reading-panel');
    }
    const panels = this.elements.filter(e => !e.hidden && e.getClientRects().length).map(e => {
      const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };
    }).filter(p => p.width > 2 && p.height > 2);
    const area = usableScene({ x: 8, y: 8, width: width - 16, height: height - 16 }, panels);
    const key = JSON.stringify([width, height, area]);
    if (key !== this.previous) { this.previous = key; this.onArea(area); }
  }

  destroy(): void {
    cancelAnimationFrame(this.frame); this.resize.disconnect(); this.mutations.disconnect();
    document.removeEventListener('click', this.click);
    document.removeEventListener('keydown', this.keydown);
  }
}
