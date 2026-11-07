import { test, expect, open, pause, ready, actionable, observeFailures } from './fixtures';

for (const id of ['scaling', 'outage', 'drain', 'redis']) {
  test(`guided experiment completes: ${id}`, async ({ page }) => {
    await open(page);
    await page.getByLabel('Playback speed').selectOption('4');
    await page.locator('#scenario').selectOption(id);
    await expect(page.locator('#experiment-action')).toBeEnabled();
    await page.locator('#experiment-action').click();
    await expect(page.locator('#experiment-title')).toContainText('Verified', { timeout: 30_000 });
    await expect(page.locator('#experiment-evidence')).toContainText('successful requests/s');
    await page.getByRole('button', { name: 'Free running', exact: true }).click();
    await expect(page.locator('#experiment-panel')).toBeHidden();
  });
}

test('baseline and candidate compare the same observed window', async ({ page }) => {
  test.setTimeout(100_000);
  await open(page);
  await page.locator('#reset').click();
  await page.getByLabel('Playback speed').selectOption('4');
  await page.locator('#show-comparison').click();
  await page.getByRole('button', { name: 'Save baseline', exact: true }).click();
  await page.locator('#pause').click();
  await expect(page.locator('#comparison-status')).toContainText('Baseline saved', { timeout: 40_000 });
  await page.getByRole('button', { name: 'Prepare candidate', exact: true }).click();
  await expect(page.locator('#sim-time')).toHaveText('0.00 s');
  await expect(page.locator('#playback-state')).toHaveText('Paused');
  await page.locator('#pause').click();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await page.locator('#map-navigation').focus(); await page.keyboard.press('ArrowRight');
  await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await expect(page.locator('#comparison-result')).toContainText('Identical settings and interventions', { timeout: 40_000 });
  await expect(page.locator('#comparison-result .comparison-error')).toHaveCount(0);
  const rows = page.locator('#comparison-result tbody tr');
  await expect(rows).toHaveCount(13);
  for (const row of await rows.all()) {
    const cells = await row.locator('td').allTextContents();
    expect(cells[1], await row.locator('th').innerText()).toBe(cells[0]);
    expect(Number.parseFloat(cells[2]!)).toBe(0);
  }
  expect(Number.parseFloat(await rows.filter({ hasText: 'Successful throughput' }).locator('td').first().innerText())).toBeGreaterThan(0);
  await expect(page.locator('#playback-state')).toHaveText('Paused');
  await page.getByRole('button', { name: 'Close comparison' }).click();
  await expect(page.locator('#show-comparison')).toBeFocused();
});

for (const viewport of [{ width: 390, height: 844 }, { width: 768, height: 1024 }, { width: 1280, height: 720 }]) {
  for (const replicas of [1, 3, 8]) {
    test(`${viewport.width}×${viewport.height}, ${replicas} replicas and panels`, async ({ page }, info) => {
      await page.setViewportSize(viewport);
      await open(page);
      if (replicas !== 3) await page.locator('#scenario').selectOption(replicas === 1 ? 'scaling' : 'redis');
      await pause(page);
      await expect(page.locator('#inspect-component option')).toHaveCount(replicas + 4);
      if (replicas !== 3) {
        if (viewport.width <= 1024) await page.locator('#experiment-panel [data-reading]').click();
        await actionable(page.locator('#experiment-exit'));
        await page.locator('#experiment-exit').click();
      }
      await page.getByLabel('Inspect component', { exact: true }).selectOption('redis');
      await expect(page.locator('#inspector-body h2')).toHaveText('Redis');
      await actionable(page.getByRole('button', { name: 'Close inspector' }));
      await page.screenshot({ path: info.outputPath('redis-inspector.png') });
      await page.getByRole('button', { name: 'Close inspector' }).click();
      for (const [toggle, panel, close] of [['show-diagnostics', 'diagnostics', 'Close console'], ['show-comparison', 'comparison-panel', 'Close comparison']]) {
        await page.locator(`#${toggle}`).click();
        await expect(page.locator(`#${panel}`)).toBeVisible();
        await actionable(page.getByRole('button', { name: close }));
        await page.getByRole('button', { name: close }).click();
        await expect(page.locator(`#${toggle}`)).toBeFocused();
      }
      const time = await page.locator('#sim-time').textContent();
      await page.setViewportSize({ width: viewport.height, height: viewport.width });
      await actionable(page.locator('#pause'));
      await page.setViewportSize(viewport);
      await expect(page.locator('#sim-time')).toHaveText(time!);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

test('readiness waits for the delayed renderer module', async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let intercepted!: () => void;
  const interceptedPromise = new Promise<void>(resolve => { intercepted = resolve; });
  await page.route(/\/assets\/WebGLRenderer-.*\.js$/, async route => {
    intercepted(); await gate; await route.continue();
  });
  await page.goto('./', { waitUntil: 'domcontentloaded' });
  try {
    await Promise.race([interceptedPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('Renderer module was not intercepted')), 5_000))]);
    await expect(page.locator('#pause')).toBeVisible();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'loading');
    await expect(ready(page, 250)).rejects.toThrow();
  } finally { release(); }
  await ready(page);
});

test('hiding the page pauses without resetting the experiment', async ({ page }) => {
  await open(page);
  await expect(page.locator('#sim-time')).not.toHaveText('0.00 s');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#playback-state')).toHaveText('Paused');
  const time = await page.locator('#sim-time').textContent();
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(page.locator('#playback-state')).toHaveText('Paused');
  await expect(page.locator('#sim-time')).toHaveText(time!);
  await page.locator('#pause').click();
  await expect(page.locator('#sim-time')).not.toHaveText(time!);
});

test('acceptance guards reject covered controls and lost focus', async ({ page }) => {
  await open(page);
  await pause(page);
  await page.locator('#show-diagnostics').click();
  await page.getByRole('button', { name: 'Close console' }).click();
  await expect(page.locator('#show-diagnostics')).toBeFocused();
  await page.locator('#pause').focus();
  await expect(expect(page.locator('#show-diagnostics')).toBeFocused({ timeout: 250 })).rejects.toThrow();
  await page.evaluate(() => {
    const cover = document.createElement('div');
    cover.style.cssText = 'position:fixed;inset:0;z-index:99999;background:white';
    document.body.append(cover);
  });
  await expect(actionable(page.locator('#pause'), 250)).rejects.toThrow();
});

test('acceptance guards reject a missing built JavaScript asset', async ({ context }, info) => {
  const broken = await context.newPage();
  const errors = observeFailures(broken);
  try {
    await broken.route(/\/assets\/index-.*\.js$/, route => route.fulfill({ status: 404, body: 'Injected missing asset' }));
    await broken.goto('./');
    await expect.poll(() => errors.some(error => error.includes('404'))).toBe(true);
    expect(() => expect(errors).toEqual([])).toThrow();
    await expect(ready(broken, 250)).rejects.toThrow();
    await info.attach('expected-missing-asset-failure', { body: JSON.stringify(errors), contentType: 'application/json' });
  } finally { await broken.close(); }
});
