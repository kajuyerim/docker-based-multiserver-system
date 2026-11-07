import { test, expect, open, pause, actionable } from './fixtures';

test('production scene, disclosures, keyboard and lifecycle controls', async ({ page, request }) => {
  await open(page);
  await expect(page.locator('.model-disclosure')).toContainText('EDUCATIONAL MODEL');
  for (const file of ['model.txt', 'notices.txt']) {
    const response = await request.get(file);
    expect(response.ok()).toBe(true);
    expect(await response.text()).toMatch(file === 'model.txt' ? /synthetic/i : /PixiJS/);
  }
  await pause(page);
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
});
