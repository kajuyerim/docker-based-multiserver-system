import { fitScene } from './layout';
import type { Rect, Transform } from './layout';

export interface Point { x: number; y: number }
export interface ViewportState { transform: Transform; area: Rect; overview: boolean }
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const center = (r: Rect): Point => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
export const worldPoint = (p: Point, t: Transform): Point => ({ x: (p.x - t.x) / t.scale, y: (p.y - t.y) / t.scale });
export const screenPoint = (p: Point, t: Transform): Point => ({ x: p.x * t.scale + t.x, y: p.y * t.scale + t.y });

export function localPoint(client: Point, rect: Rect, size: { width: number; height: number }): Point {
  return { x: (client.x - rect.x) * size.width / Math.max(1, rect.width),
    y: (client.y - rect.y) * size.height / Math.max(1, rect.height) };
}

export function wheelFactor(delta: number, mode: number, pageHeight: number): number {
  const pixels = delta * (mode === 1 ? 16 : mode === 2 ? pageHeight : 1);
  return Math.exp(-clamp(pixels, -120, 120) * .002);
}

export class Viewport {
  private bounds: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private geometry: readonly Rect[] = [];
  private area: Rect = { x: 0, y: 0, width: 1, height: 1 };
  private current: Transform = { x: 0, y: 0, scale: 1 };
  private overview = true;

  get transform(): Transform { return { ...this.current }; }
  get scene(): Rect { return { ...this.area }; }
  get fitScale(): number { return fitScene(this.bounds, this.area, 30).scale; }
  get zoom(): number { return this.current.scale / this.fitScale; }

  context(bounds: Rect, area: Rect, geometry: readonly Rect[]): void {
    if (area.width <= 0 || area.height <= 0) return;
    const anchor = worldPoint(center(this.area), this.current);
    this.bounds = { ...bounds }; this.area = { ...area }; this.geometry = geometry.map(r => ({ ...r }));
    if (this.overview) this.fit();
    else {
      const scale = clamp(this.current.scale, this.fitScale * .75, this.fitScale * 4);
      const p = center(area);
      this.move({ scale, x: p.x - anchor.x * scale, y: p.y - anchor.y * scale });
    }
  }

  fit(): void {
    this.current = this.constrain(fitScene(this.bounds, this.area, 30));
    this.overview = true;
  }

  move(next: Transform): void { this.current = this.constrain(next); this.overview = false; }

  pan(delta: Point): void { this.move({ ...this.current, x: this.current.x + delta.x, y: this.current.y + delta.y }); }

  zoomAt(factor: number, point = center(this.area), previousPoint = point): void {
    const anchor = worldPoint(previousPoint, this.current);
    const scale = clamp(this.current.scale * factor, this.fitScale * .75, this.fitScale * 4);
    this.move({ scale, x: point.x - anchor.x * scale, y: point.y - anchor.y * scale });
  }

  focusTarget(target: Rect): Transform {
    const scale = clamp(fitScene(target, this.area, 60).scale, this.fitScale, this.fitScale * 4);
    const p = center(this.area), w = center(target);
    return this.constrain({ scale, x: p.x - w.x * scale, y: p.y - w.y * scale });
  }

  save(): ViewportState { return { transform: this.transform, area: this.scene, overview: this.overview }; }

  restore(state: ViewportState): void {
    if (state.overview) { this.fit(); return; }
    const anchor = worldPoint(center(state.area), state.transform), p = center(this.area);
    const scale = clamp(state.transform.scale, this.fitScale * .75, this.fitScale * 4);
    this.move({ scale, x: p.x - anchor.x * scale, y: p.y - anchor.y * scale });
  }

  private constrain(next: Transform): Transform {
    const { bounds: b, area: a } = this;
    const scale = clamp(next.scale, this.fitScale * .75, this.fitScale * 4);
    const axis = (value: number, start: number, size: number, from: number, length: number) =>
      length * scale <= size ? start + (size - length * scale) / 2 - from * scale :
        clamp(value, start + size - (from + length) * scale, start - from * scale);
    const t = { scale, x: axis(next.x, a.x, a.width, b.x, b.width), y: axis(next.y, a.y, a.height, b.y, b.height) };
    const projected = this.geometry.map(r => ({ x: r.x * scale + t.x, y: r.y * scale + t.y,
      width: r.width * scale, height: r.height * scale }));
    const inset = Math.min(32, a.width / 4, a.height / 4);
    if (projected.length && !projected.map(center).some(p => p.x >= a.x + inset && p.x <= a.x + a.width - inset &&
      p.y >= a.y + inset && p.y <= a.y + a.height - inset)) {
      const p = center(a);
      const nearest = projected.map(center).sort((x, y) => Math.hypot(x.x - p.x, x.y - p.y) - Math.hypot(y.x - p.x, y.y - p.y))[0]!;
      t.x += clamp(nearest.x, a.x + inset, a.x + a.width - inset) - nearest.x;
      t.y += clamp(nearest.y, a.y + inset, a.y + a.height - inset) - nearest.y;
    }
    return t;
  }
}
