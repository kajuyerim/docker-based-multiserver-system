import { chromium, test, expect } from '@playwright/test';
import { fileURLToPath } from 'node:url';
import { actionable, observeFailures, pause, ready } from './fixtures';

test('real browser page zoom at 200% retains map controls and inspection', async ({}, info) => {
  const extension = fileURLToPath(new URL('./zoom-extension', import.meta.url));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', viewport: { width: 1280, height: 720 },
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`,
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker', { timeout: 8000 });
    const page = context.pages()[0]!;
    const errors = observeFailures(page);
    await page.goto(info.project.use.baseURL!); await ready(page); await pause(page);
    const before = await page.locator('#sim-time, #global').allTextContents();
    const factor = await worker.evaluate(async () => {
      const api = (globalThis as unknown as { chrome: { tabs: {
        query: (q: object) => Promise<{ id: number; url?: string }[]>;
        setZoom: (id: number, zoom: number) => Promise<void>; getZoom: (id: number) => Promise<number>;
      } } }).chrome.tabs;
      const tab = (await api.query({})).find(t => t.url?.startsWith('http://127.0.0.1:'))!;
      await api.setZoom(tab.id, 2); return api.getZoom(tab.id);
    });
    expect(factor).toBe(2);
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(640);
    await page.getByLabel('Inspect component', { exact: true }).selectOption('redis');
    for (const button of await page.locator('#map-navigation button').all()) await actionable(button);
    await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
    await actionable(page.locator('[data-scene-component="redis"]'));
    await page.getByRole('button', { name: 'Fit map', exact: true }).click();
    await expect(page.locator('#map-zoom')).toHaveText('100%');
    await page.locator('#inspector-panel [data-reading]').click();
    await page.locator('#redis-rtt').focus(); await page.keyboard.press('ArrowRight');
    await expect(page.locator('#redis-rtt')).toHaveValue('5');
    await page.keyboard.press('Escape');
    expect(await page.locator('#sim-time, #global').allTextContents()).toEqual(before);
    await page.screenshot({ path: info.outputPath('browser-zoom-200.png') });
    expect(errors).toEqual([]);
  } finally { await context.close(); }
});
