import { expect, actionable } from './fixtures';
import type { Page, TestInfo } from '@playwright/test';

export async function sceneCenter(page: Page): Promise<{ x: number; y: number }> {
  return page.locator('#campus').evaluate(e => {
    const value = (name: string) => parseFloat((e as HTMLElement).style.getPropertyValue(`--scene-${name}`));
    return { x: value('x') + value('width') / 2, y: value('y') + value('height') / 2 };
  });
}
async function settledFocus(page: Page): Promise<void> {
  let previous = '', stable = 0;
  await expect.poll(async () => {
    const zoom = await page.locator('#map-zoom').innerText();
    stable = zoom === previous ? stable + 1 : 0; previous = zoom;
    return stable;
  }, { intervals: [50] }).toBeGreaterThanOrEqual(2);
}
export async function navigationJourney(page: Page, info: TestInfo): Promise<void> {
  const before = await page.locator('#sim-time, #global').allTextContents();
  for (const button of await page.locator('#map-navigation button').all()) await actionable(button);
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  for (let i = 0; i < 4; i++) await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect(page.locator('#map-zoom')).toHaveText('244%');
  const center = await sceneCenter(page), selected = await page.locator('#inspector-body h2').textContent();
  const canvasBefore = await page.locator('#campus canvas').screenshot();
  await page.mouse.move(center.x, center.y);
  await page.mouse.down();
  await page.mouse.move(center.x + 60, center.y + 25, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('#campus')).toHaveAttribute('data-dragging', 'false');
  await expect(page.locator('#inspector-body h2')).toHaveText(selected!);
  expect((await page.locator('#campus canvas').screenshot()).equals(canvasBefore)).toBe(false);
  await page.mouse.wheel(0, 60);
  await expect.poll(async () => Number.parseInt(await page.locator('#map-zoom').innerText())).toBeLessThan(244);
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await expect(page.locator('#map-zoom')).toHaveText('100%');
  await page.locator('[data-scene-component="nginx"]').click();
  await expect(page.locator('#inspector-body h2')).toHaveText('NGINX');
  await page.locator('[data-scene-component="redis"]').click();
  await expect(page.locator('#inspector-body h2')).toHaveText('Redis');
  await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
  await expect.poll(async () => Number.parseInt(await page.locator('#map-zoom').innerText())).toBeGreaterThan(100);
  await expect(page.locator('[data-scene-component="redis"]')).toBeVisible();
  await settledFocus(page);
  await page.screenshot({ path: info.outputPath('focused-redis.png') });
  for (const toggle of ['show-diagnostics', 'show-comparison', 'show-inspector']) {
    await page.locator(`#${toggle}`).click();
    await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
    await expect(page.locator('[data-scene-component="redis"]')).toBeVisible();
    await actionable(page.getByRole('button', { name: 'Fit map', exact: true }));
  }
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.height, height: viewport.width });
  await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
  await actionable(page.locator('[data-scene-component="redis"]'));
  await page.setViewportSize(viewport);
  await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
  await actionable(page.locator('[data-scene-component="redis"]'));
  expect(await page.locator('#sim-time, #global').allTextContents()).toEqual(before);
  await page.locator('#inspector-panel [data-reading]').click();
  const rtt = page.locator('#redis-rtt'), old = Number(await rtt.inputValue());
  await rtt.focus(); await page.keyboard.press('ArrowRight');
  await expect(rtt).toHaveValue(String(old + 1));
  await page.locator('#step').click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await expect(page.locator('#map-zoom')).toHaveText('100%');
  const count = await page.locator('#inspect-component option').count() - 4;
  await page.locator('#scenario').selectOption(count === 1 ? 'scaling' : count === 8 ? 'redis' : 'outage');
  await page.locator('#pause').click();
  await expect(page.locator('#playback-state')).toHaveText('Paused');
  await expect(page.locator('#experiment-panel')).toBeVisible();
  const experimentTime = await page.locator('#sim-time, #global').allTextContents();
  for (const name of ['Zoom out', 'Zoom in', 'Focus selected', 'Fit map']) {
    await page.getByRole('button', { name, exact: true }).click();
  }
  await expect(page.locator('#map-zoom')).toHaveText('100%');
  expect(await page.locator('#sim-time, #global').allTextContents()).toEqual(experimentTime);
}
