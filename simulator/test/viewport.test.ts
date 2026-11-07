import { expect, it } from 'vitest';
import { localPoint, screenPoint, Viewport, wheelFactor, worldPoint } from '../src/view/viewport';
import { overlaps } from '../src/view/layout';
import type { Rect } from '../src/view/layout';
import { Engine } from '../src/model/engine';

const area = { x: 240, y: 120, width: 740, height: 510 };
const bounds = { x: 30, y: -10, width: 1125, height: 640 };
const geometry: Rect[] = [
  { x: 35, y: 245, width: 170, height: 140 }, { x: 245, y: 215, width: 170, height: 140 },
  { x: 575, y: 40, width: 170, height: 140 }, { x: 575, y: 230, width: 170, height: 140 },
  { x: 575, y: 420, width: 170, height: 140 }, { x: 945, y: 215, width: 170, height: 140 },
];
const setup = () => { const view = new Viewport(); view.context(bounds, area, geometry); return view; };

it('preserves the pointer world anchor while zooming away from constraints', () => {
  const view = setup();
  view.zoomAt(2);
  const pointer = { x: 590, y: 340 }, before = worldPoint(pointer, view.transform);
  view.zoomAt(1.2, pointer);
  const after = screenPoint(before, view.transform);
  expect(after.x).toBeCloseTo(pointer.x, 8);
  expect(after.y).toBeCloseTo(pointer.y, 8);
  view.zoomAt(1.1, { x: 620, y: 350 }, pointer);
  const moved = screenPoint(before, view.transform);
  expect(moved.x).toBeCloseTo(620, 8);
  expect(moved.y).toBeCloseTo(350, 8);
});

it('converts CSS-local input without applying device pixel ratio and bounds wheel jumps', () => {
  expect(localPoint({ x: 260, y: 170 }, { x: 60, y: 70, width: 800, height: 400 }, { width: 400, height: 200 }))
    .toEqual({ x: 100, y: 50 });
  expect(wheelFactor(3, 1, 800)).toBe(wheelFactor(48, 0, 800));
  expect(wheelFactor(10_000, 0, 800)).toBeGreaterThan(.78);
  expect(wheelFactor(-10_000, 0, 800)).toBeLessThan(1.28);
  expect(wheelFactor(1, 2, 800)).toBe(wheelFactor(800, 0, 800));
});

it('constrains extremes without losing every building and fit recovers overview', () => {
  const view = setup();
  for (const zoom of [.0001, .75, 1, 2, 4, 1000]) for (const x of [-1e6, 0, 1e6]) for (const y of [-1e6, 0, 1e6]) {
    view.move({ scale: view.fitScale * zoom, x, y });
    const t = view.transform;
    expect(view.zoom).toBeGreaterThanOrEqual(.75 - 1e-10);
    expect(view.zoom).toBeLessThanOrEqual(4 + 1e-10);
    expect(geometry.some(r => overlaps(area, { x: r.x * t.scale + t.x, y: r.y * t.scale + t.y,
      width: r.width * t.scale, height: r.height * t.scale }))).toBe(true);
    expect(geometry.some(r => {
      const p = screenPoint({ x: r.x + r.width / 2, y: r.y + r.height / 2 }, t);
      return p.x >= area.x + 32 - 1e-8 && p.x <= area.x + area.width - 32 + 1e-8 &&
        p.y >= area.y + 32 - 1e-8 && p.y <= area.y + area.height - 32 + 1e-8;
    })).toBe(true);
  }
  view.fit();
  expect(view.zoom).toBe(1);
  const t = view.transform;
  expect(screenPoint({ x: bounds.x, y: bounds.y }, t).x).toBeGreaterThanOrEqual(area.x);
  expect(screenPoint({ x: bounds.x + bounds.width, y: bounds.y + bounds.height }, t).y).toBeLessThanOrEqual(area.y + area.height);
});

it('preserves a manual anchor on resize and saves/restores campus framing', () => {
  const view = setup(); view.zoomAt(2); view.pan({ x: 50, y: -20 });
  const state = view.save(), before = worldPoint({ x: 610, y: 375 }, view.transform);
  view.move(view.focusTarget(geometry[5]!));
  view.restore(state);
  expect(view.transform).toEqual(state.transform);
  const resized = { x: 220, y: 100, width: 700, height: 490 };
  view.context(bounds, resized, geometry);
  expect(worldPoint({ x: 570, y: 345 }, view.transform)).toEqual(before);
  const after = view.transform;
  view.context(bounds, { x: 0, y: 0, width: 0, height: 0 }, geometry);
  expect(view.transform).toEqual(after);
  view.restore({ ...state, overview: true });
  expect(view.zoom).toBe(1);
});

it('navigation and inspection have no effect on identical seeded model runs', () => {
  const baseline = new Engine(), inspected = new Engine(), view = setup();
  for (let tick = 0; tick < 400; tick++) {
    baseline.step(); inspected.step();
    view.pan({ x: tick % 7 - 3, y: tick % 5 - 2 }); view.zoomAt(tick % 2 ? .9 : 1.1);
    if (tick % 30 === 0) view.move(view.focusTarget(geometry[tick % geometry.length]!));
    if (tick % 60 === 0) view.fit();
  }
  expect(inspected.snapshot()).toEqual(baseline.snapshot());
});
