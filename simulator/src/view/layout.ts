export interface Rect { x: number; y: number; width: number; height: number }
export interface Transform { x: number; y: number; scale: number }
export const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

export function usableScene(view: Rect, panels: readonly Rect[], gap = 8): Rect {
  const blocks = panels.map(p => ({ x: Math.max(view.x, p.x - gap), y: Math.max(view.y, p.y - gap),
    width: Math.min(view.x + view.width, p.x + p.width + gap) - Math.max(view.x, p.x - gap),
    height: Math.min(view.y + view.height, p.y + p.height + gap) - Math.max(view.y, p.y - gap),
  })).filter(p => p.width > 0 && p.height > 0);
  const xs = [...new Set([view.x, view.x + view.width, ...blocks.flatMap(p => [p.x, p.x + p.width])])].sort((a, b) => a - b);
  const ys = [...new Set([view.y, view.y + view.height, ...blocks.flatMap(p => [p.y, p.y + p.height])])].sort((a, b) => a - b);
  let best: Rect = { x: view.x, y: view.y, width: 0, height: 0 };
  for (let l = 0; l < xs.length - 1; l++) for (let r = l + 1; r < xs.length; r++) {
    for (let t = 0; t < ys.length - 1; t++) for (let b = t + 1; b < ys.length; b++) {
      const rect = { x: xs[l]!, y: ys[t]!, width: xs[r]! - xs[l]!, height: ys[b]! - ys[t]! };
      if (rect.width * rect.height > best.width * best.height && !blocks.some(p => overlaps(rect, p))) best = rect;
    }
  }
  return best;
}

export function fitScene(bounds: Rect, area: Rect, padding = 24): Transform {
  const scale = Math.max(0.01, Math.min(Math.max(1, area.width - 2 * padding) / bounds.width,
    Math.max(1, area.height - 2 * padding) / bounds.height));
  return { scale, x: area.x + area.width / 2 - (bounds.x + bounds.width / 2) * scale,
    y: area.y + area.height / 2 - (bounds.y + bounds.height / 2) * scale };
}

export function placeLabel(anchor: Rect, size: { width: number; height: number }, area: Rect, occupied: readonly Rect[], relocate = false): Rect | undefined {
  if (size.width > area.width || size.height > area.height) return undefined;
  const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
  const x = clamp(anchor.x + (anchor.width - size.width) / 2, area.x, area.x + area.width - size.width);
  const candidates = [
    { x, y: anchor.y - size.height - 4 }, { x, y: anchor.y + anchor.height + 4 },
    { x: anchor.x + anchor.width + 4, y: anchor.y }, { x: anchor.x - size.width - 4, y: anchor.y },
  ];
  for (const p of candidates) {
    const rect = { ...p, ...size, y: clamp(p.y, area.y, area.y + area.height - size.height) };
    if (rect.x >= area.x && rect.x + rect.width <= area.x + area.width && !occupied.some(other => overlaps(rect, other))) return rect;
  }
  if (relocate) {
    const xs = [x, area.x, area.x + area.width - size.width, ...occupied.flatMap(r => [r.x - size.width - 4, r.x + r.width + 4])];
    const ys = [area.y, area.y + area.height - size.height, ...occupied.flatMap(r => [r.y - size.height - 4, r.y + r.height + 4])];
    const alternatives = xs.flatMap(x => ys.map(y => ({ x, y, ...size })))
      .filter(r => r.x >= area.x && r.y >= area.y && r.x + r.width <= area.x + area.width && r.y + r.height <= area.y + area.height)
      .sort((a, b) => Math.hypot(a.x - anchor.x, a.y - anchor.y) - Math.hypot(b.x - anchor.x, b.y - anchor.y));
    return alternatives.find(r => !occupied.some(other => overlaps(r, other)));
  }
  return undefined;
}
