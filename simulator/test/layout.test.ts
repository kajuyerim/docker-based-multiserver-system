import { expect, it } from 'vitest';
import { fitScene, overlaps, placeLabel, usableScene } from '../src/view/layout';

it('chooses unobscured space beside actual panels and fits the complete topology', () => {
  const view = { x: 0, y: 0, width: 1280, height: 720 };
  const panels = [
    { x: 0, y: 0, width: 1280, height: 120 }, { x: 0, y: 650, width: 1280, height: 70 },
    { x: 0, y: 120, width: 230, height: 400 }, { x: 990, y: 120, width: 290, height: 500 },
  ];
  const area = usableScene(view, panels);
  expect(area.width).toBeGreaterThan(700);
  expect(area.height).toBeGreaterThan(500);
  for (const panel of panels) expect(overlaps(area, panel)).toBe(false);
  const bounds = { x: 30, y: -10, width: 1125, height: 640 };
  const t = fitScene(bounds, area);
  expect(bounds.x * t.scale + t.x).toBeGreaterThanOrEqual(area.x);
  expect(bounds.y * t.scale + t.y).toBeGreaterThanOrEqual(area.y);
  expect((bounds.x + bounds.width) * t.scale + t.x).toBeLessThanOrEqual(area.x + area.width);
  expect((bounds.y + bounds.height) * t.scale + t.y).toBeLessThanOrEqual(area.y + area.height);
});

it('handles clipped overlays, no overlays, and fully covered reading views', () => {
  const view = { x: 8, y: 8, width: 374, height: 828 };
  expect(usableScene(view, [])).toEqual(view);
  const panel = { x: -100, y: 100, width: 800, height: 80 };
  expect(overlaps(usableScene(view, [panel]), panel)).toBe(false);
  const covered = usableScene(view, [{ x: 0, y: 0, width: 400, height: 900 }]);
  expect(covered.width * covered.height).toBe(0);
  expect(Number.isFinite(fitScene(view, covered).scale)).toBe(true);
});

it('places measured labels without colliding and reports no placement instead of shrinking text', () => {
  const area = { x: 0, y: 0, width: 390, height: 422 };
  const anchor = { x: 140, y: 100, width: 60, height: 50 };
  const size = { width: 150, height: 40 };
  const first = placeLabel(anchor, size, area, []);
  expect(first).toBeDefined();
  const next = placeLabel(anchor, size, area, [first!]);
  expect(next).toBeDefined();
  expect(overlaps(first!, next!)).toBe(false);
  expect(placeLabel(anchor, size, area, [area])).toBeUndefined();
  expect(placeLabel(anchor, size, { ...area, height: 30 }, [])).toBeUndefined();
  const crowded = { x: 0, y: 50, width: 390, height: 150 };
  expect(placeLabel(anchor, size, area, [crowded])).toBeUndefined();
  const relocated = placeLabel(anchor, size, area, [crowded], true);
  expect(relocated).toBeDefined();
  expect(overlaps(relocated!, crowded)).toBe(false);
});
