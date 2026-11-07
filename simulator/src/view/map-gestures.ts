import type { Point } from './viewport';
import { Viewport } from './viewport';

interface Contact { point: Point; start: Point }
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: Point, b: Point): Point => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

export class MapGestures {
  private contacts = new Map<number, Contact>();
  private ignored = new Set<number>();
  private suppressed = false;
  private dragging = false;

  constructor(private view: Viewport) {}
  get active(): boolean { return this.contacts.size > 0; }
  get ids(): number[] { return [...this.contacts.keys(), ...this.ignored]; }

  down(id: number, point: Point): void {
    if (!this.contacts.size && !this.ignored.size) { this.suppressed = false; this.dragging = false; }
    if (this.contacts.size >= 2) {
      if (this.ignored.size < 16) this.ignored.add(id);
      this.suppressed = true;
      return;
    }
    this.contacts.set(id, { point, start: point });
    if (this.contacts.size === 2) { this.suppressed = true; this.dragging = true; }
  }

  move(id: number, point: Point): boolean {
    const contact = this.contacts.get(id);
    if (!contact) return false;
    const previous = [...this.contacts.values()].map(c => c.point);
    const last = contact.point;
    contact.point = point;
    if (this.contacts.size === 2) {
      const next = [...this.contacts.values()].map(c => c.point);
      const span = distance(previous[0]!, previous[1]!);
      this.view.zoomAt(span > 1 ? distance(next[0]!, next[1]!) / span : 1,
        midpoint(next[0]!, next[1]!), midpoint(previous[0]!, previous[1]!));
      return true;
    }
    const wasDragging = this.dragging;
    if (distance(contact.start, point) >= 5) { this.dragging = true; this.suppressed = true; }
    if (!this.dragging) return false;
    const origin = wasDragging ? last : contact.start;
    this.view.pan({ x: point.x - origin.x, y: point.y - origin.y });
    return true;
  }

  up(id: number): void {
    this.contacts.delete(id); this.ignored.delete(id);
    for (const contact of this.contacts.values()) contact.start = contact.point;
  }

  cancel(): void { this.contacts.clear(); this.ignored.clear(); this.suppressed = true; this.dragging = false; }

  canSelect(id: number | undefined, point?: Point): boolean {
    const contact = id === undefined ? undefined : this.contacts.get(id);
    return !this.suppressed && !(contact && point && distance(contact.start, point) >= 5);
  }
}
