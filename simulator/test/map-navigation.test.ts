import { afterEach, expect, it, vi } from 'vitest';
import { MapNavigation } from '../src/ui/map-navigation';
import { Viewport } from '../src/view/viewport';

class Surface extends EventTarget {
  clientWidth = 500;
  clientHeight = 500;
  dataset: Record<string, string> = {};
  captured = new Set<number>();
  getBoundingClientRect() { return { x: 0, y: 0, width: 500, height: 500 }; }
  closest() { return this; }
  setPointerCapture(id: number) { this.captured.add(id); }
  hasPointerCapture(id: number) { return this.captured.has(id); }
  releasePointerCapture(id: number) { this.captured.delete(id); }
}
const fire = (target: EventTarget, type: string, props: Record<string, unknown> = {}) => {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { clientX: 250, clientY: 250, pointerId: 1, button: 0, ...props });
  target.dispatchEvent(event);
  return event;
};
const setup = () => {
  const host = new Surface(), controls = new Surface(), window = new EventTarget();
  const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
  vi.stubGlobal('window', window);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const flush = (now = performance.now()) => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn(now)); };
  const view = new Viewport();
  view.context({ x: 0, y: 0, width: 1000, height: 1000 }, { x: 0, y: 0, width: 500, height: 500 }, []);
  view.zoomAt(2);
  const changed = vi.fn(), callbacks = { changed, focusTarget: () => ({ x: 400, y: 400, width: 100, height: 100 }), reduced: () => false };
  const mount = () => new MapNavigation(host as unknown as HTMLElement, controls as unknown as HTMLElement, view, callbacks);
  return { host, controls, window, frames, flush, view, changed, callbacks, mount };
};
afterEach(() => vi.unstubAllGlobals());

it('clears pointer capture on release, cancellation, lost capture, blur and repeated disposal', () => {
  const s = setup();
  for (let repeat = 0; repeat < 3; repeat++) {
    const nav = s.mount();
    for (const reason of ['pointerup', 'pointercancel', 'lostpointercapture', 'blur']) {
      fire(s.host, 'pointerdown');
      expect(s.host.captured.has(1)).toBe(true);
      fire(s.host, 'pointermove', { clientX: 275 });
      fire(reason === 'lostpointercapture' ? s.host : s.window, reason);
      expect(s.host.captured.size).toBe(0);
      expect(s.host.dataset.dragging).toBe('false');
      const before = s.view.transform;
      fire(s.host, 'pointermove', { clientX: 300 });
      expect(s.view.transform).toEqual(before);
    }
    fire(s.host, 'pointerdown');
    fire(s.host, 'pointermove', { clientX: 280 });
    nav.destroy();
    expect(s.host.captured.size).toBe(0);
    expect(s.frames.size).toBe(0);
    const before = s.view.transform;
    expect(fire(s.host, 'wheel', { deltaY: -100, deltaMode: 0 }).defaultPrevented).toBe(false);
    fire(s.controls, 'keydown', { key: '+' });
    fire(s.host, 'pointerdown');
    expect(s.view.transform).toEqual(before);
    expect(s.host.captured.size).toBe(0);
  }
});

it('coalesces rendering and preserves browser zoom, native keys and outside controls', () => {
  const s = setup(), nav = s.mount(), before = s.view.transform;
  for (const key of ['Tab', 'Enter', ' ', 'a']) expect(fire(s.controls, 'keydown', { key }).defaultPrevented).toBe(false);
  expect(fire(s.window, 'keydown', { key: 'ArrowRight' }).defaultPrevented).toBe(false);
  for (const modifier of ['ctrlKey', 'metaKey']) {
    expect(fire(s.host, 'wheel', { deltaY: -100, deltaMode: 0, [modifier]: true }).defaultPrevented).toBe(false);
    expect(fire(s.controls, 'keydown', { key: '+', [modifier]: true }).defaultPrevented).toBe(false);
  }
  expect(s.view.transform).toEqual(before);
  for (let i = 0; i < 5; i++) expect(fire(s.host, 'wheel', { deltaY: -10, deltaMode: 0 }).defaultPrevented).toBe(true);
  expect(s.frames.size).toBe(1); expect(s.changed).not.toHaveBeenCalled();
  s.flush(); expect(s.changed).toHaveBeenCalledTimes(1);
  nav.destroy();
});

it('removes focus movement with reduced motion and interrupts animated focus at its current position', () => {
  const s = setup(), nav = s.mount();
  s.callbacks.reduced = () => true;
  const target = s.view.focusTarget(s.callbacks.focusTarget());
  nav.focus();
  expect(s.view.transform).toEqual(target);
  s.flush(); expect(s.frames.size).toBe(0);
  nav.fit(); s.flush();
  s.callbacks.reduced = () => false;
  const start = s.view.transform;
  nav.focus(); s.flush(performance.now() + 40);
  const during = s.view.transform;
  expect(during).not.toEqual(start); expect(during).not.toEqual(target);
  fire(s.host, 'pointerdown');
  expect(s.frames.size).toBe(0);
  expect(s.view.transform).toEqual(during);
  nav.destroy();
});
