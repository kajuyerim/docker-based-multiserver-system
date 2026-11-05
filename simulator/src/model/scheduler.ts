export const TICK_US = 20_000;
export const SECOND = 1_000_000;
export const PRIORITY = { command: 0, service: 1, deadline: 2, arrival: 3 } as const;

interface Event {
  id: number;
  at: number;
  priority: number;
  run: () => void;
}

function before(a: Event, b: Event): boolean {
  return a.at < b.at || (a.at === b.at &&
    (a.priority < b.priority || (a.priority === b.priority && a.id < b.id)));
}

export class Scheduler {
  now = 0;
  private sequence = 0;
  private heap: Event[] = [];
  private positions = new Map<number, number>();

  constructor(private readonly onAdvance: (elapsed: number) => void = () => {}) {}

  get size(): number { return this.heap.length; }

  schedule(at: number, priority: number, run: () => void): number {
    if (!Number.isSafeInteger(at) || at < this.now) throw new Error('Event time must be an integer at or after now');
    const event = { id: ++this.sequence, at, priority, run };
    this.heap.push(event);
    this.positions.set(event.id, this.heap.length - 1);
    this.up(this.heap.length - 1);
    return event.id;
  }

  cancel(id: number): void {
    const index = this.positions.get(id);
    if (index !== undefined) this.remove(index);
  }

  advanceTo(time: number): void {
    if (!Number.isSafeInteger(time) || time < this.now) throw new Error('Time cannot move backwards');
    while (this.heap[0] && this.heap[0].at <= time) {
      const next = this.heap[0];
      this.remove(0);
      this.onAdvance(next.at - this.now);
      this.now = next.at;
      next.run();
    }
    this.onAdvance(time - this.now);
    this.now = time;
  }

  private swap(a: number, b: number): void {
    const first = this.heap[a]!;
    this.heap[a] = this.heap[b]!;
    this.heap[b] = first;
    this.positions.set(this.heap[a]!.id, a);
    this.positions.set(first.id, b);
  }

  private up(index: number): number {
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!before(this.heap[index]!, this.heap[parent]!)) break;
      this.swap(index, parent);
      index = parent;
    }
    return index;
  }

  private down(index: number): void {
    for (;;) {
      let child = index * 2 + 1;
      if (child >= this.heap.length) return;
      if (child + 1 < this.heap.length && before(this.heap[child + 1]!, this.heap[child]!)) child++;
      if (!before(this.heap[child]!, this.heap[index]!)) return;
      this.swap(index, child);
      index = child;
    }
  }

  private remove(index: number): void {
    const removed = this.heap[index]!;
    const last = this.heap.pop()!;
    this.positions.delete(removed.id);
    if (index < this.heap.length) {
      this.heap[index] = last;
      this.positions.set(last.id, index);
      this.down(this.up(index));
    }
  }
}
