import type { Locator } from '@playwright/test';
import { test, expect, open } from './fixtures';

test('production scene, disclosures, keyboard and lifecycle controls', async ({ page, hasTouch }) => {
  const activate = (control: Locator, trial = false) => hasTouch ? control.tap({ trial }) : control.click({ trial });
  const actionable = async (control: Locator) => {
    await expect(control).toBeInViewport({ ratio: 0.9 });
    await activate(control, true);
  };
  await open(page);
  await expect(page.locator('.model-disclosure')).toContainText('EDUCATIONAL MODEL');
  if (await page.locator('#playback-state').textContent() === 'Running') await activate(page.locator('#pause'));
  await expect(page.locator('#playback-state')).toHaveText('Paused');
  await expect(page.locator('.transport-bar > a')).toHaveAttribute('href', '/docker-based-multiserver-system/model.txt');
  await activate(page.getByRole('button', { name: 'Guide', exact: true }));
  for (const [name, file, content] of [
    ['Model assumptions', 'model.txt', /synthetic/i],
    ['Asset and dependency notices', 'notices.txt', /PixiJS/],
  ] as const) {
    const link = page.getByRole('dialog').getByRole('link', { name });
    await expect(link).toHaveAttribute('href', `/docker-based-multiserver-system/${file}`);
    const [opened] = await Promise.all([page.waitForEvent('popup'), activate(link)]);
    await expect(opened).toHaveURL(new URL(file, page.url()).href);
    await expect(opened.locator('body')).toContainText(content);
    await opened.close();
  }
  await activate(page.getByRole('button', { name: 'Return to simulation' }));
  await activate(page.locator('#reset'));
  await expect(page.locator('#sim-time')).toHaveText('0.00 s');
  await activate(page.locator('#step'));
  await expect(page.locator('#sim-time')).toHaveText('0.02 s');
  await page.getByLabel('Inspect component', { exact: true }).selectOption('app1');
  await expect(page.locator('#inspector-body h2')).toHaveText('app1');
  await page.getByLabel('CPU capacity').focus();
  await page.keyboard.press('ArrowRight');
  await activate(page.locator('#step'));
  await expect(page.locator('#capacity-value')).toHaveText('55 /s');
  await activate(page.getByRole('button', { name: 'Stop now', exact: true }));
  await activate(page.locator('#step'));
  await expect(page.locator('#component-state')).toContainText('Stopped');
  await activate(page.getByRole('button', { name: 'Close inspector' }));
  await expect(page.locator('#show-inspector')).toBeFocused();
  await page.getByRole('button', { name: 'Guide', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('#intro')).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await activate(page.getByText('Workload settings', { exact: true }));
  await expect(page.getByLabel('Reduce motion', { exact: true })).toBeChecked();
  await activate(page.locator('#close-workload'));
  await expect(page.locator('#workload-settings')).not.toHaveAttribute('open');
  await expect(page.locator('#workload-settings summary')).toBeFocused();
  await actionable(page.locator('#pause'));
  await activate(page.getByRole('button', { name: 'Focus selected', exact: true }));
  await expect.poll(async () => Number.parseInt(await page.locator('#map-zoom').innerText())).toBeGreaterThan(100);
  await actionable(page.locator('[data-scene-component="app1"]'));
  await activate(page.getByRole('button', { name: 'Fit map', exact: true }));
  await expect(page.locator('#map-zoom')).toHaveText('100%');
});
