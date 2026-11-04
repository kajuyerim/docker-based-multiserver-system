import { TICK_US } from './scheduler';

export class Clock {
  paused = true;
  speed = 1;
  private accumulatedUs = 0;
  private ticks = 0;

  constructor(private readonly advance: () => void) {}

  get tick(): number { return this.ticks; }
  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  setSpeed(speed: number): void {
    if (![0.25, 0.5, 1, 2, 4].includes(speed)) throw new Error('Unsupported playback speed');
    this.speed = speed;
  }
  step(): void { this.advance(); this.ticks++; }
  reset(): void { this.ticks = 0; this.accumulatedUs = 0; this.paused = true; }

  consume(elapsedMs: number, maxSteps = 100): { steps: number; behind: boolean } {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Invalid elapsed time');
    if (this.paused) return { steps: 0, behind: false };
    this.accumulatedUs += elapsedMs * 1000 * this.speed;
    let steps = 0;
    while (this.accumulatedUs + 0.000001 >= TICK_US && steps < maxSteps) {
      this.step();
      this.accumulatedUs -= TICK_US;
      steps++;
    }
    return { steps, behind: this.accumulatedUs >= TICK_US };
  }
}
