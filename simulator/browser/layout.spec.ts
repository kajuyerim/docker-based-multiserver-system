import { test, expect, open, pause, actionable } from './fixtures';
import type { Page } from '@playwright/test';
import { navigationJourney } from './navigation-journey';

async function sceneIsClear(page: Page, selected: string): Promise<void> {
  const label = page.locator(`[data-scene-component="${selected}"]`);
  await expect(label).toBeVisible();
  await actionable(label);
  await expect.poll(() => page.evaluate(id => {
    const host = document.getElementById('campus')!;
    const values = ['x', 'y', 'width', 'height'].map(name => parseFloat(host.style.getPropertyValue(`--scene-${name}`)));
    const [x, y, width, height] = values as [number, number, number, number];
    if (innerWidth <= 1024 && width * height < innerWidth * innerHeight * .499) return false;
    const label = document.querySelector<HTMLElement>(`[data-scene-component="${id}"]`)!;
    const r = label.getBoundingClientRect();
    return r.left >= x - .5 && r.right <= x + width + .5 && r.top >= y - .5 && r.bottom <= y + height + .5 &&
      [...document.querySelectorAll<HTMLElement>('[data-scene-overlay]')].filter(e => !e.hidden).every(e => {
        const p = e.getBoundingClientRect();
        return p.width <= 2 || p.height <= 2 || x >= p.right || x + width <= p.left || y >= p.bottom || y + height <= p.top;
      });
  }, selected)).toBe(true);
  expect(await label.evaluate(e => parseFloat(getComputedStyle(e).fontSize))).toBeGreaterThanOrEqual(12);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 720 }]) {
  for (const replicas of [1, 3, 8]) {
    test(`readable scene ${viewport.width}×${viewport.height}, ${replicas} replicas`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await open(page);
      for (const vital of await page.locator('.vital').all()) {
        await vital.scrollIntoViewIfNeeded();
        await expect(vital).toBeInViewport({ ratio: .95 });
      }
      await page.locator('.vital').first().scrollIntoViewIfNeeded();
      await expect(page.locator('#feedback')).toBeInViewport({ ratio: .95 });
      if (replicas !== 3) await page.locator('#scenario').selectOption(replicas === 1 ? 'scaling' : 'redis');
      await pause(page);
      if (replicas !== 3) await page.locator('#experiment-exit').click();
      const before = await page.locator('#sim-time, #global').allTextContents();
      const ids = ['clients', 'nginx', ...Array.from({ length: replicas }, (_, i) => `app${i + 1}`), 'redis'];
      for (const id of ids) {
        await page.getByLabel('Inspect component', { exact: true }).selectOption(id);
        await sceneIsClear(page, id);
      }
      await page.screenshot({ path: info.outputPath('redis-inspector.png') });
      if (viewport.width <= 1024) {
        const fraction = await page.locator('#campus').evaluate(e =>
          parseFloat((e as HTMLElement).style.getPropertyValue('--scene-width')) *
          parseFloat((e as HTMLElement).style.getPropertyValue('--scene-height')) / (innerWidth * innerHeight));
        expect(fraction).toBeGreaterThanOrEqual(.499);
        await page.locator('#inspector-panel [data-reading]').click();
        await expect(page.locator('#inspector-panel [data-reading]')).toHaveText('Return to map');
        await page.locator('#inspector-panel [data-reading]').click();
        await expect(page.locator('#inspector-panel [data-reading]')).toBeFocused();
        await sceneIsClear(page, 'redis');
      }
      for (const [toggle, panel] of [['show-diagnostics', 'diagnostics'], ['show-comparison', 'comparison-panel'], ['show-inspector', 'inspector-panel']]) {
        await page.locator(`#${toggle}`).click();
        await expect(page.locator(`#${panel}`)).toBeVisible();
        await expect(page.locator('#inspector-panel:visible, #diagnostics:visible, #comparison-panel:visible, #experiment-panel:visible')).toHaveCount(1);
        await sceneIsClear(page, 'redis');
      }
      await page.setViewportSize({ width: viewport.height, height: viewport.width });
      await sceneIsClear(page, 'redis');
      await actionable(page.locator('#pause'));
      await page.setViewportSize(viewport);
      await sceneIsClear(page, 'redis');
      expect(await page.locator('#sim-time, #global').allTextContents()).toEqual(before);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await navigationJourney(page, info);
    });
  }
}

test('collapsed experiment stays collapsed while the model continues', async ({ page }) => {
  await open(page);
  await page.locator('#scenario').selectOption('scaling');
  await page.locator('#collapse-experiment').click();
  const before = await page.locator('#sim-time').innerText();
  await expect(page.locator('#sim-time')).not.toHaveText(before);
  await expect(page.locator('#experiment-panel')).toBeHidden();
  await page.locator('#show-experiment').click();
  await expect(page.locator('#experiment-panel')).toBeVisible();
});

test('phone reading views preserve settings, disclosure choices and focus', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await pause(page);
  await page.getByLabel('Inspect component', { exact: true }).selectOption('redis');
  await page.locator('#inspector-panel [data-reading]').click();
  await page.getByText('Advanced Redis', { exact: true }).click();
  await page.getByLabel('PUBLISH processing').focus();
  const before = await page.locator('#sim-time, #global').allTextContents();
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.getByLabel('PUBLISH processing')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#inspector-panel [data-reading]')).toBeFocused();
  await page.locator('#show-diagnostics').click();
  await page.locator('#show-inspector').click();
  await expect(page.locator('#inspector-body details')).toHaveAttribute('open', '');
  await page.getByText('Workload settings', { exact: true }).click();
  await actionable(page.locator('#close-workload'));
  await page.keyboard.press('Escape');
  await expect(page.locator('#workload-settings summary')).toBeFocused();
  await sceneIsClear(page, 'redis');
  expect(await page.locator('#sim-time, #global').allTextContents()).toEqual(before);
});

test('phone attention labels remain readable with eight stopped backends', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page);
  await page.locator('#scenario').selectOption('redis');
  await pause(page);
  await page.locator('#experiment-panel [data-reading]').click();
  await page.locator('#experiment-exit').click();
  for (let id = 1; id <= 8; id++) {
    await page.getByLabel('Inspect component', { exact: true }).selectOption(`app${id}`);
    await page.locator('#inspector-panel [data-reading]').click();
    await page.getByRole('button', { name: 'Stop now', exact: true }).click();
    await page.locator('#step').click();
    await page.keyboard.press('Escape');
  }
  await page.getByLabel('Inspect component', { exact: true }).selectOption('redis');
  for (let id = 1; id <= 8; id++) {
    const label = page.locator(`[data-scene-component="app${id}"]`);
    await expect(label).toBeVisible();
    await expect(label).toContainText('Stopped');
    await actionable(label);
  }
  await sceneIsClear(page, 'redis');
  await page.screenshot({ path: info.outputPath('attention-labels.png') });
});
