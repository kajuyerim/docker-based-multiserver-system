import type { Page, TestInfo } from '@playwright/test';
import { test, expect, open, actionable } from './fixtures';

// Drive the public controls, including their input handlers and queued-command boundary.
async function range(page: Page, id: string, value: number): Promise<void> {
  await page.locator(`#${id}`).evaluate((element, next) => {
    (element as HTMLInputElement).value = String(next);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

async function steps(page: Page, count: number): Promise<void> {
  await expect(page.locator('#playback-state')).toHaveText('Paused');
  await expect(page.locator('#step')).toBeEnabled();
  await page.locator('#step').evaluate(async (button, ticks) => {
    for (let i = 0; i < ticks; i++) {
      (button as HTMLButtonElement).click();
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    }
  }, count);
}

async function configure(page: Page, options: { slow?: boolean; rtt?: number; retry?: boolean } = {}): Promise<void> {
  await open(page);
  await page.locator('#reset').click();
  await range(page, 'rate', 1);
  await range(page, 'slow', options.slow ? 100 : 0);
  await page.locator('#workload-settings summary').click();
  const reduced = await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  await expect(page.locator('#reduced-motion')).toBeChecked({ checked: reduced });
  await range(page, 'jitter', 0);
  await page.locator('#close-workload').click();
  if (options.rtt !== undefined) {
    await page.getByLabel('Inspect component', { exact: true }).selectOption('redis');
    await range(page, 'redis-rtt', options.rtt);
  }
  if (options.retry === false) {
    await page.getByLabel('Inspect component', { exact: true }).selectOption('nginx');
    await page.locator('#inspector-panel [data-reading]').click();
    await page.locator('#retry').uncheck();
    await page.locator('#inspector-panel [data-reading]').click();
  }
  await steps(page, 1);
  if (await page.locator('#fresh-settings').isVisible()) await page.locator('#fresh-settings').click();
  else {
    await page.getByLabel('Inspect component', { exact: true }).selectOption('clients');
    await page.locator('#inspector-panel [data-reading]').click();
    await page.locator('#run-settings').click();
    await page.locator('#inspector-panel [data-reading]').click();
  }
  await page.locator('#reset').click();
  await expect(page.locator('#sim-time')).toHaveText('0.00 s');
}

async function consoleTrace(page: Page, id = 1): Promise<void> {
  if (!await page.locator('#diagnostics').isVisible()) await page.locator('#show-diagnostics').click();
  await page.locator('#trace-id').fill(String(id));
  if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await page.locator('#inspect-trace').tap();
  else await page.locator('#inspect-trace').click();
  await expect(page.locator('#follow-request')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#trace-event-identity')).toContainText(`Request ${id}`);
}

async function event(page: Page, message: RegExp): Promise<void> {
  const reading = page.locator('#diagnostics [data-reading]');
  if (page.viewportSize()!.width <= 1024 && await reading.getAttribute('aria-expanded') !== 'true') await reading.click();
  const row = page.locator('#trace-list button').filter({ hasText: message });
  await expect(row).toHaveCount(1);
  if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await row.tap();
  else await row.click();
  await expect(row).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#trace-event-time')).toContainText('Historical event');
  await expect(page.locator('#trace-event-time')).toContainText('Queues and counters are not rewound');
}

async function currentState(page: Page): Promise<string[]> {
  return page.locator('#sim-time, #global, #pending, #sample-count, #summary, #replica-table').allTextContents();
}

async function scenePixels(page: Page): Promise<Buffer> {
  await page.mouse.move(0, 0);
  const clip = await page.locator('#campus').evaluate(element => {
    const value = (name: string) => parseFloat((element as HTMLElement).style.getPropertyValue(`--scene-${name}`));
    return { x: value('x'), y: value('y'), width: value('width'), height: value('height') };
  });
  return page.screenshot({ clip });
}

async function keyboardSequence(page: Page): Promise<string[]> {
  const reading = page.locator('#diagnostics [data-reading]');
  if (page.viewportSize()!.width <= 1024 && await reading.getAttribute('aria-expanded') !== 'true') await reading.click();
  const before = await currentState(page);
  const zoom = await page.locator('#map-zoom').innerText();
  const rows = page.locator('#trace-list button');
  const count = await rows.count();
  await rows.first().click();
  await expect(page.locator('#trace-previous')).toBeDisabled();
  const titles: string[] = [];
  for (let index = 0; index < count; index++) {
    const title = await page.locator('#trace-event-title').innerText();
    expect(title).toMatch(new RegExp(`^${index + 1}/${count} · `));
    titles.push(title.replace(/^\d+\/\d+ · /, ''));
    await expect(page.locator('#trace-event-identity')).toContainText('Request 1');
    await expect(page.locator('#trace-event-time')).toContainText('Historical event');
    if (index < count - 1) {
      await page.locator('#trace-next').focus();
      await page.keyboard.press('Enter');
    }
  }
  await expect(page.locator('#trace-next')).toBeDisabled();
  await page.locator('#trace-previous').focus();
  await page.keyboard.press('Space');
  await expect(page.locator('#trace-event-title')).toHaveText(`${count - 1}/${count} · ${titles[count - 2]}`);
  await page.locator('#trace-latest-event').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#trace-event-title')).toHaveText(`${count}/${count} · ${titles[count - 1]}`);
  await expect(page.locator('#trace-latest-event')).toHaveAttribute('aria-pressed', 'true');
  expect(await currentState(page), 'Inspection leaves current model evidence unchanged').toEqual(before);
  await expect(page.locator('#map-zoom')).toHaveText(zoom);
  return titles;
}

async function screenshotPair(page: Page, info: TestInfo, name: string, component: string): Promise<void> {
  const reading = page.locator('#diagnostics [data-reading]');
  if (await reading.getAttribute('aria-expanded') !== 'true') await reading.click();
  await page.locator('#trace-evidence').evaluate(element => element.scrollIntoView({ block: 'center' }));
  await expect(page.locator('#trace-event-title')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('#trace-event-explanation')).toBeInViewport({ ratio: 1 });
  for (const id of ['trace-event-title', 'trace-event-explanation']) {
    expect(await page.locator(`#${id}`).evaluate(element => {
      const r = element.getBoundingClientRect();
      return element.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
    }), `${id} is not covered by the sticky console heading`).toBe(true);
  }
  const evidencePath = info.outputPath(`${name}-evidence.png`);
  await page.screenshot({ path: evidencePath });
  await info.attach(`${name}-evidence`, { contentType: 'image/png', path: evidencePath });
  const before = await currentState(page), title = await page.locator('#trace-event-title').innerText();
  await page.keyboard.press('Escape');
  await expect(reading).toBeFocused();
  await expect(reading).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#trace-event-title')).toHaveText(title);
  expect(await currentState(page), 'Leaving reading mode preserves the cursor and current system').toEqual(before);
  const label = page.locator(`[data-scene-component="${component}"].request-event`);
  await expect(label).toBeVisible();
  await actionable(label);
  expect(await label.evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(12);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const scenePath = info.outputPath(`${name}-scene.png`);
  await page.screenshot({ path: scenePath });
  await info.attach(`${name}-scene`, { contentType: 'image/png', path: scenePath });
  await info.attach(`${name}-trace`, { contentType: 'application/json', body: JSON.stringify({
    build: info.config.metadata, viewport: page.viewportSize(),
    syntheticTouch: await page.evaluate(() => navigator.maxTouchPoints > 0),
    reducedMotion: await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches),
    state: await currentState(page),
    evidence: await page.locator('#trace-evidence').innerText(),
    events: await page.locator('#trace-list button').allTextContents(),
  }, null, 2) });
}

const rootSequence = [
  'Client request offered', 'Upstream attempt', 'Handler entry', 'CPU queue', 'CPU execution',
  'INCR sent', 'INCR queued', 'INCR executing', 'INCR updated in memory', 'INCR reply reached Go',
  'PUBLISH sent', 'PUBLISH queued', 'PUBLISH executing', 'PUBLISH executed', 'PUBLISH reply reached Go',
  'CPU queue', 'CPU execution', 'Backend response sent', 'Client success',
];

for (const profile of [
  { name: 'desktop', viewport: { width: 1280, height: 720 }, reducedMotion: 'no-preference' as const, isMobile: false, hasTouch: false },
  { name: 'phone reduced motion', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' as const, isMobile: true, hasTouch: true },
]) {
  test.describe(`request follow: ${profile.name}`, () => {
    test.use({ viewport: profile.viewport, reducedMotion: profile.reducedMotion, isMobile: profile.isMobile, hasTouch: profile.hasTouch });

    test('root success keeps its historical path under a full background pool', async ({ page }, info) => {
      await configure(page);
      await steps(page, 60);
      await consoleTrace(page);
      await expect(page.locator('#trace-result')).toHaveText('GET / · success');
      expect(await keyboardSequence(page)).toEqual(rootSequence);
      await event(page, /INCR committed;/);
      await expect(page.locator('#trace-event-identity')).toHaveText('Request 1 / attempt 1 / app1 · incarnation 1 / operation 1');
      await expect(page.locator('#trace-event-explanation')).toContainText('not today’s global count or proof of client success');
      await event(page, /Send PUBLISH/);
      await expect(page.locator('#trace-event-explanation')).toContainText('separate best-effort command');
      await expect(page.locator('#trace-event-identity')).toContainText('operation 2');
      await event(page, /INCR committed;/);
      await screenshotPair(page, info, 'root-incr', 'redis');

      const globalMetric = page.getByRole('button', { name: 'Inspect global counter', exact: true });
      await expect(globalMetric).toHaveAccessibleDescription('1 committed INCR operations.');
      await globalMetric.click();
      await expect(page.locator('#inspector-body h2')).toHaveText('Redis');
      await expect(page.locator('.metric-explanation')).toContainText('not a delivered-response or durability count');
      await page.locator('#show-diagnostics').click();
      const original = await page.locator('#trace-list button').allTextContents();
      await range(page, 'rate', 500);
      await range(page, 'slow', 100);
      await steps(page, 150);
      await expect(page.locator('#trace-event-title')).toContainText('INCR updated in memory');
      expect(await page.locator('#trace-list button').allTextContents()).toEqual(original);
      await expect(page.locator('#global')).toHaveText('1');
      await expect(page.locator('#trace-event-explanation')).toContainText('atomically produced 1');
      await page.getByLabel('Inspect component', { exact: true }).selectOption('clients');
      expect(Number.parseInt((await page.locator('#component-state').innerText()).replaceAll(',', ''))).toBeGreaterThan(1000);
      await page.locator('#show-diagnostics').click();
      await expect(page.locator('#trace-retention')).toContainText('separate from the 200 background markers');
      await screenshotPair(page, info, 'root-full-pool', 'redis');
      const before = await currentState(page);
      const followed = await scenePixels(page);
      await page.locator('#follow-request').click();
      await expect(page.locator('.component-label.request-event')).toHaveCount(0);
      expect((await scenePixels(page)).equals(followed)).toBe(false);
      await page.locator('#follow-request').click();
      await expect(page.locator('[data-scene-component="redis"]')).toHaveClass(/request-event/);
      expect((await scenePixels(page)).equals(followed)).toBe(true);
      expect(await currentState(page)).toEqual(before);
    });

    test('queued-work metric follows current growth and recovery without rewinding the selected trace', async ({ page }, info) => {
      await configure(page);
      await steps(page, 60);
      await consoleTrace(page);
      await event(page, /INCR committed;/);
      await page.keyboard.press('Escape');
      await range(page, 'rate', 500);
      await steps(page, 21);
      expect(Number(await page.locator('#queue').innerText())).toBeGreaterThan(0);
      await expect(page.locator('#global')).not.toHaveText('1');
      await expect(page.locator('#trace-event-explanation')).toContainText('atomically produced 1');
      await screenshotPair(page, info, 'root-queue-growth', 'redis');
      await page.getByRole('button', { name: 'Inspect queued work', exact: true }).click();
      await expect(page.locator('#inspector-body h2')).toHaveText('app1');
      await expect(page.locator('.metric-explanation')).toContainText('largest current queue');
      await range(page, 'rate', 0);
      await steps(page, 1);
      await page.getByLabel('Inspect component', { exact: true }).selectOption('clients');
      const offered = Number.parseInt(await page.locator('#component-state').innerText());
      expect(offered).toBeGreaterThan(200);
      await steps(page, 199);
      await expect(page.locator('#queue')).toHaveText('0');
      await expect(page.locator('#pending')).toHaveText('0');
      await expect(page.locator('#global')).toHaveText(String(offered));
      await expect(page.locator('#sample-count')).toHaveText(String(offered));
      await page.locator('#show-diagnostics').click();
      await expect(page.locator('#trace-event-title')).toContainText('INCR updated in memory');
      await expect(page.locator('#trace-event-explanation')).toContainText('atomically produced 1');
      await screenshotPair(page, info, 'root-queue-recovered', 'redis');
    });

    test('/slow releases CPU while sleeping and never touches Redis or counters', async ({ page }, info) => {
      await configure(page, { slow: true });
      await steps(page, 52);
      await range(page, 'rate', 0);
      await steps(page, 1);
      await consoleTrace(page);
      await expect(page.locator('#trace-result')).toHaveText('GET /slow · in flight');
      await event(page, /Sleeping for 2s/);
      await expect(page.locator('#trace-event-title')).toContainText('Sleeping · CPU released');
      await expect(page.locator('#trace-event-explanation')).toContainText('makes no Redis call');
      await expect(page.locator('#trace-current-pressure')).toContainText('CPU queued 0 · CPU active 0 · Sleeping 1 · Redis wait 0');
      await expect(page.locator('#global')).toHaveText('0');
      await expect(page.locator('#summary')).toContainText('lifetime local entries 0');
      await screenshotPair(page, info, 'slow-sleeping', 'app1');
      await page.locator('#trace-component').click();
      await expect(page.locator('#inspector-body h2')).toHaveText('app1');
      await expect(page.locator('#component-stats')).toContainText('CPU active0Sleeping1Redis wait0');
      await page.locator('#show-diagnostics').click();
      await steps(page, 100);
      await expect(page.locator('#trace-result')).toHaveText('GET /slow · success');
      expect(await keyboardSequence(page)).toEqual([
        'Client request offered', 'Upstream attempt', 'Handler entry', 'CPU queue', 'CPU execution',
        'Sleeping · CPU released', 'CPU queue', 'CPU execution', 'Backend response sent', 'Client success',
      ]);
      await expect(page.locator('#trace-list')).not.toContainText('INCR');
      await expect(page.locator('#trace-list')).not.toContainText('PUBLISH');
      await expect(page.locator('#global')).toHaveText('0');
      await expect(page.locator('#summary')).toContainText('lifetime local entries 0');
    });

    test('failed upstream retries within the same offered request', async ({ page }, info) => {
      await configure(page);
      await page.getByLabel('Inspect component', { exact: true }).selectOption('app1');
      await page.locator('#inspector-panel [data-reading]').click();
      await page.getByRole('button', { name: 'Stop now', exact: true }).click();
      await page.locator('#inspector-panel [data-reading]').click();
      await steps(page, 60);
      await consoleTrace(page);
      await expect(page.locator('#trace-result')).toHaveText('GET / · success');
      const sequence = await keyboardSequence(page);
      expect(sequence).toEqual([
        'Client request offered', 'Upstream attempt', 'Upstream failed', 'Retry · same client request',
        ...rootSequence.slice(1),
      ]);
      await event(page, /connection refused;/);
      await expect(page.locator('#trace-event-identity')).toContainText('Request 1 / attempt 1 / app1 · incarnation 1');
      await event(page, /NGINX tries another eligible upstream/);
      await expect(page.locator('#trace-event-explanation')).toContainText('not an offered client request');
      await expect(page.locator('#trace-current-pressure')).toContainText('Attempts total 2 · Retries total 1');
      await screenshotPair(page, info, 'failed-upstream-retry', 'nginx');
      await event(page, /NGINX → app2, attempt 2 of 3/);
      await expect(page.locator('#trace-event-identity')).toContainText('Request 1 / attempt 2 / app2 · incarnation 1');
      await page.keyboard.press('Escape');
      await page.getByLabel('Inspect component', { exact: true }).selectOption('clients');
      await expect(page.locator('#component-state')).toHaveText('1 offered since reset');
      await expect(page.locator('#component-stats')).toContainText('Succeeded1Failed0');
      await expect(page.locator('#global')).toHaveText('1');
    });

    test('INCR remains applied when the client fails before the reply', async ({ page }, info) => {
      await configure(page, { rtt: 1000, retry: false });
      await steps(page, 77);
      await consoleTrace(page);
      await expect(page.locator('#trace-result')).toHaveText('GET / · in flight');
      await expect(page.locator('#global')).toHaveText('1');
      await event(page, /INCR committed;/);
      await expect(page.locator('#trace-event-identity')).toHaveText('Request 1 / attempt 1 / app1 · incarnation 1 / operation 1');
      await expect(page.locator('#trace-current-pressure')).toContainText('Queued 0 · Executing 0 · In transport 1');
      await expect(page.locator('#trace-list')).not.toContainText('acknowledged');
      await expect(page.locator('#trace-list')).not.toContainText('PUBLISH');
      await range(page, 'rate', 0);
      await page.getByLabel('Inspect component', { exact: true }).selectOption('app1');
      await page.locator('#inspector-panel [data-reading]').click();
      await page.getByRole('button', { name: 'Stop now', exact: true }).click();
      await page.locator('#inspector-panel [data-reading]').click();
      await steps(page, 1);
      await consoleTrace(page);
      await expect(page.locator('#trace-result')).toHaveText('GET / · proxy_failure');
      expect(await keyboardSequence(page)).toEqual([...rootSequence.slice(0, 9), 'Upstream failed', 'Client failure']);
      await expect(page.locator('#trace-event-explanation')).toContainText('committed increments are not rolled back');
      await expect(page.locator('#trace-current-pressure')).toContainText('Offered total 1 · Succeeded total 0 · Failed total 1');
      await screenshotPair(page, info, 'committed-client-failure', 'clients');
      await event(page, /INCR committed;/);
      await expect(page.locator('#trace-event-explanation')).toContainText('not today’s global count or proof of client success');
      await expect(page.locator('#trace-current-pressure')).toContainText('Executing 0 · In transport 1 · Detached 1');
      await expect(page.locator('#global')).toHaveText('1');
      await expect(page.locator('#pending')).toHaveText('0');
      await screenshotPair(page, info, 'committed-incr-after-failure', 'redis');
    });
  });
}
