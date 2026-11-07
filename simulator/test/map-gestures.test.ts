import { expect, it } from 'vitest';
import { MapGestures } from '../src/view/map-gestures';
import { screenPoint, Viewport, worldPoint } from '../src/view/viewport';

const setup = () => {
  const view = new Viewport();
  view.context({ x: 0, y: 0, width: 1000, height: 1000 }, { x: 0, y: 0, width: 500, height: 500 }, []);
  view.zoomAt(2);
  return { view, gesture: new MapGestures(view) };
};

it('distinguishes taps from drags and suppresses the completed drag selection', () => {
  const { view, gesture } = setup();
  const before = view.transform;
  gesture.down(1, { x: 200, y: 200 });
  expect(gesture.move(1, { x: 203, y: 201 })).toBe(false);
  expect(view.transform).toEqual(before);
  expect(gesture.canSelect(1, { x: 203, y: 201 })).toBe(true);
  expect(gesture.canSelect(1, { x: 220, y: 200 })).toBe(false);
  expect(gesture.move(1, { x: 220, y: 200 })).toBe(true);
  expect(view.transform.x).toBe(before.x + 20);
  gesture.up(1);
  expect(gesture.canSelect(1)).toBe(false);
  gesture.down(1, { x: 220, y: 200 });
  expect(gesture.canSelect(1)).toBe(true);
});

it('pinches about the moving centroid and rebases when one finger leaves', () => {
  const { view, gesture } = setup();
  const anchor = worldPoint({ x: 250, y: 250 }, view.transform);
  gesture.down(1, { x: 200, y: 250 }); gesture.down(2, { x: 300, y: 250 });
  gesture.move(2, { x: 340, y: 270 });
  expect(screenPoint(anchor, view.transform).x).toBeCloseTo(270, 8);
  expect(screenPoint(anchor, view.transform).y).toBeCloseTo(260, 8);
  expect(gesture.canSelect(1)).toBe(false);
  gesture.up(2);
  const before = view.transform;
  gesture.move(1, { x: 210, y: 255 });
  expect(view.transform.x).toBeCloseTo(before.x + 10, 8);
  expect(view.transform.y).toBeCloseTo(before.y + 5, 8);
  gesture.up(1);
  expect(gesture.canSelect(1)).toBe(false);
});

it('ignores extra contacts and cancellation clears state without a stray selection', () => {
  const { view, gesture } = setup();
  gesture.down(1, { x: 200, y: 250 }); gesture.down(2, { x: 300, y: 250 }); gesture.down(3, { x: 250, y: 300 });
  const before = view.transform;
  expect(gesture.move(3, { x: 400, y: 400 })).toBe(false);
  expect(view.transform).toEqual(before);
  gesture.up(1); gesture.up(2);
  expect(gesture.canSelect(3)).toBe(false);
  gesture.cancel();
  expect(gesture.ids).toEqual([]); expect(gesture.active).toBe(false);
  expect(gesture.move(2, { x: 450, y: 400 })).toBe(false);
  gesture.down(7, { x: 250, y: 250 });
  expect(gesture.canSelect(7)).toBe(true);
});
