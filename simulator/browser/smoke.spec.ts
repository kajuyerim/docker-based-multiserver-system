import { test, expect, open, pause, actionable } from './fixtures';

test('production scene, disclosures, keyboard and lifecycle controls', async ({ page }) => {
  await open(page);
  await expect(page.locator('.model-disclosure')).toContainText('EDUCATIONAL MODEL');
  await pause(page);
  await expect(page.locator('.transport-bar > a')).toHaveAttribute('href', '/docker-based-multiserver-system/model.txt');
  await page.getByRole('button', { name: 'Guide', exact: true }).click();
  for (const [name, file, content] of [
    ['Model assumptions', 'model.txt', /synthetic/i],
    ['Asset and dependency notices', 'notices.txt', /PixiJS/],
  ] as const) {
    const link = page.getByRole('dialog').getByRole('link', { name });
    await expect(link).toHaveAttribute('href', `/docker-based-multiserver-system/${file}`);
    const [opened] = await Promise.all([page.waitForEvent('popup'), link.click()]);
    await expect(opened).toHaveURL(new URL(file, page.url()).href);
    await expect(opened.locator('body')).toContainText(content);
    await opened.close();
  }
  await page.getByRole('button', { name: 'Return to simulation' }).click();
  await page.locator('#reset').click();
  await expect(page.locator('#sim-time')).toHaveText('0.00 s');
  await page.locator('#step').click();
  await expect(page.locator('#sim-time')).toHaveText('0.02 s');
  await page.getByLabel('Inspect component', { exact: true }).selectOption('app1');
  await expect(page.locator('#inspector-body h2')).toHaveText('app1');
  await page.getByLabel('CPU capacity').focus();
  await page.keyboard.press('ArrowRight');
  await page.locator('#step').click();
  await expect(page.locator('#capacity-value')).toHaveText('55 /s');
  await page.getByRole('button', { name: 'Stop now', exact: true }).click();
  await page.locator('#step').click();
  await expect(page.locator('#component-state')).toContainText('Stopped');
  await page.getByRole('button', { name: 'Close inspector' }).click();
  await expect(page.locator('#show-inspector')).toBeFocused();
  await page.getByRole('button', { name: 'Guide', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.locator('#intro')).toBeFocused();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.getByText('Workload settings', { exact: true }).click();
  await expect(page.getByLabel('Reduce motion', { exact: true })).toBeChecked();
  await page.getByText('Workload settings', { exact: true }).click();
  await actionable(page.locator('#pause'));
  await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
  await expect.poll(async () => Number.parseInt(await page.locator('#map-zoom').innerText())).toBeGreaterThan(100);
  await actionable(page.locator('[data-scene-component="app1"]'));
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await expect(page.locator('#map-zoom')).toHaveText('100%');
});
