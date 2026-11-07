import { test as base, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

export function observeFailures(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('response', response => { if (response.status() >= 400) errors.push(`${response.status()} ${response.url()}`); });
  page.on('requestfailed', request => errors.push(`${request.failure()?.errorText} ${request.url()}`));
  return errors;
}

export const test = base.extend<{ browserEvidence: string[] }>({
  browserEvidence: [async ({ page }, use, info) => {
    const errors = observeFailures(page);
    await use(errors);
    if (info.status !== info.expectedStatus || errors.length) {
      await info.attach('browser-state', { contentType: 'application/json', body: JSON.stringify({
        errors, build: info.config.metadata,
        state: await page.locator('body').innerText().catch(() => 'Page unavailable'),
        focus: await page.evaluate(() => document.activeElement?.outerHTML).catch(() => null),
      }, null, 2) });
    }
    expect(errors, 'Browser exceptions, console errors and failed assets').toEqual([]);
  }, { auto: true }],
});
export { expect };

export async function ready(page: Page, timeout = 8_000): Promise<void> {
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'ready', { timeout });
  await expect(page.locator('#campus canvas')).toBeVisible({ timeout });
  await expect(page.locator('#inspect-component option')).toHaveCount(7, { timeout });
}

export async function open(page: Page): Promise<void> {
  await page.goto('./');
  await ready(page);
}

export async function actionable(control: Locator, timeout = 8_000): Promise<void> {
  await expect(control).toBeInViewport({ ratio: 0.9, timeout });
  await control.click({ trial: true, timeout });
}

export async function pause(page: Page): Promise<void> {
  if (await page.locator('#playback-state').textContent() === 'Running') await page.locator('#pause').click();
  await expect(page.locator('#playback-state')).toHaveText('Paused');
}
