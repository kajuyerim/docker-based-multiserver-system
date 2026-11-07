import { MapGestures } from '../view/map-gestures';
import { localPoint, Viewport, wheelFactor } from '../view/viewport';
import type { Point } from '../view/viewport';
import type { Rect } from '../view/layout';

export class MapNavigation {
  private gestures: MapGestures;
  private captures = new Map<number, Element>();
  private frame = 0;
  private animation = 0;

  constructor(private host: HTMLElement, private controls: HTMLElement, readonly view: Viewport,
    private callbacks: { changed: () => void; focusTarget: () => Rect; reduced: () => boolean }) {
    this.gestures = new MapGestures(view);
    host.addEventListener('pointerdown', this.down, true);
    host.addEventListener('pointermove', this.move, true);
    host.addEventListener('lostpointercapture', this.lost);
    host.addEventListener('wheel', this.wheel, { passive: false });
    window.addEventListener('pointerup', this.end, true);
    window.addEventListener('pointercancel', this.end, true);
    window.addEventListener('blur', this.cancel);
    controls.addEventListener('click', this.click);
    controls.addEventListener('keydown', this.key);
  }

  canSelect(event: MouseEvent | PointerEvent): boolean {
    return this.gestures.canSelect('pointerId' in event ? event.pointerId : undefined, this.point(event));
  }

  private point(event: MouseEvent): Point {
    const rect = this.host.getBoundingClientRect();
    return localPoint({ x: event.clientX, y: event.clientY }, rect, { width: this.host.clientWidth, height: this.host.clientHeight });
  }

  private down = (event: PointerEvent): void => {
    if (event.button !== 0 && event.button !== 1) return;
    const target = event.target as Element;
    if (!target.closest('canvas, .component-label')) return;
    this.stop();
    this.gestures.down(event.pointerId, this.point(event));
    target.setPointerCapture(event.pointerId);
    this.captures.set(event.pointerId, target);
    this.host.dataset.dragging = 'true';
    if (event.button === 1) event.preventDefault();
  };

  private move = (event: PointerEvent): void => {
    if (this.gestures.move(event.pointerId, this.point(event))) { event.preventDefault(); this.changed(); }
  };

  private end = (event: PointerEvent): void => {
    if (!this.captures.has(event.pointerId)) return;
    if (event.type === 'pointercancel') { this.cancel(); return; }
    if (this.gestures.move(event.pointerId, this.point(event))) this.changed();
    this.gestures.up(event.pointerId);
    const target = this.captures.get(event.pointerId)!;
    this.captures.delete(event.pointerId);
    if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId);
    this.host.dataset.dragging = String(this.gestures.active);
  };

  private lost = (event: PointerEvent): void => { if (this.captures.has(event.pointerId)) this.cancel(); };

  cancel = (): void => {
    this.stop();
    this.gestures.cancel();
    const captured = [...this.captures]; this.captures.clear();
    for (const [id, target] of captured) if (target.hasPointerCapture(id)) target.releasePointerCapture(id);
    this.host.dataset.dragging = 'false';
  };

  private wheel = (event: WheelEvent): void => {
    if (event.ctrlKey || event.metaKey || !event.deltaY) return;
    event.preventDefault(); this.stop();
    this.view.zoomAt(wheelFactor(event.deltaY, event.deltaMode, this.view.scene.height), this.point(event));
    this.changed();
  };

  private click = (event: MouseEvent): void => {
    const action = (event.target as HTMLElement).closest('button')?.dataset.map;
    if (action === 'in' || action === 'out') {
      this.cancel(); this.view.zoomAt(action === 'in' ? 1.25 : .8); this.changed();
    } else if (action === 'fit') this.fit();
    else if (action === 'focus') this.focus();
  };

  private key = (event: KeyboardEvent): void => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') { this.cancel(); return; }
    if (event.key === 'Home') { event.preventDefault(); this.fit(); return; }
    const deltas: Record<string, Point> = { ArrowLeft: { x: 40, y: 0 }, ArrowRight: { x: -40, y: 0 },
      ArrowUp: { x: 0, y: 40 }, ArrowDown: { x: 0, y: -40 } };
    if (deltas[event.key]) {
      event.preventDefault(); this.cancel(); this.view.pan(deltas[event.key]!); this.changed();
    } else if (['+', '=', '-'].includes(event.key)) {
      event.preventDefault(); this.cancel(); this.view.zoomAt(event.key === '-' ? .8 : 1.25); this.changed();
    }
  };

  fit(): void { this.cancel(); this.view.fit(); this.changed(); }

  focus(): void {
    this.cancel();
    const from = this.view.transform, to = this.view.focusTarget(this.callbacks.focusTarget());
    if (this.callbacks.reduced()) { this.view.move(to); this.changed(); return; }
    const start = performance.now();
    const animate = (now: number) => {
      const progress = Math.min(1, (now - start) / 160), eased = 1 - (1 - progress) ** 2;
      this.view.move({ x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased,
        scale: from.scale + (to.scale - from.scale) * eased });
      this.callbacks.changed();
      this.animation = progress < 1 ? requestAnimationFrame(animate) : 0;
    };
    this.animation = requestAnimationFrame(animate);
  }

  private stop(): void { cancelAnimationFrame(this.animation); this.animation = 0; }

  private changed(): void {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.callbacks.changed(); });
  }

  destroy(): void {
    this.cancel(); cancelAnimationFrame(this.frame);
    this.host.removeEventListener('pointerdown', this.down, { capture: true });
    this.host.removeEventListener('pointermove', this.move, { capture: true });
    this.host.removeEventListener('lostpointercapture', this.lost);
    this.host.removeEventListener('wheel', this.wheel);
    window.removeEventListener('pointerup', this.end, { capture: true });
    window.removeEventListener('pointercancel', this.end, { capture: true });
    window.removeEventListener('blur', this.cancel);
    this.controls.removeEventListener('click', this.click);
    this.controls.removeEventListener('keydown', this.key);
  }
}
