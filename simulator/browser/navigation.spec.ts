import { test, expect, open, pause, actionable } from './fixtures';
import { sceneCenter } from './navigation-journey';

test('keyboard map controls preserve native input and modified-wheel browser zoom', async ({ page }) => {
  await open(page); await pause(page);
  const before = await page.locator('#sim-time, #global').allTextContents();
  await page.locator('#map-navigation').focus();
  await expect(page.locator('#map-navigation')).toBeFocused();
  await page.keyboard.press('+'); await expect(page.locator('#map-zoom')).toHaveText('125%');
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Escape'); await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Zoom out', exact: true })).toBeFocused();
  await page.keyboard.press('Home'); await expect(page.locator('#map-zoom')).toHaveText('100%');
  for (const modifier of ['ctrlKey', 'metaKey']) {
    expect(await page.locator('#campus canvas').evaluate((canvas, key) => {
      const event = new WheelEvent('wheel', { deltaY: -100, [key]: true, bubbles: true, cancelable: true });
      canvas.dispatchEvent(event); return event.defaultPrevented;
    }, modifier)).toBe(false);
  }
  await page.locator('#rate').focus(); await page.keyboard.press('ArrowRight');
  await expect(page.locator('#rate')).toHaveValue('31');
  await expect(page.locator('#map-zoom')).toHaveText('100%');
  expect(await page.locator('#sim-time, #global').allTextContents()).toEqual(before);
  await page.getByLabel('Inspect component', { exact: true }).selectOption('redis');
  const panel = page.locator('#inspector-panel'), box = (await panel.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await expect.poll(() => panel.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
  await expect(page.locator('#map-zoom')).toHaveText('100%');
  await page.locator('#workload-settings summary').click();
  await page.locator('#seed').fill('123'); await page.locator('#seed').press('ArrowLeft');
  await expect(page.locator('#seed')).toHaveValue('123');
  await page.keyboard.press('Escape');
  expect(await page.locator('meta[name=viewport]').getAttribute('content')).not.toMatch(/user-scalable\s*=\s*no|maximum-scale\s*=\s*1/);
});

test('dragging labels suppresses picking and cancellation permits fresh clicks', async ({ page }, info) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page); await pause(page);
  await page.getByLabel('Inspect component', { exact: true }).selectOption('redis');
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  const label = page.locator('[data-scene-component="app1"]'), box = (await label.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down(); await page.mouse.move(box.x + 70, box.y + 45, { steps: 4 }); await page.mouse.up();
  await expect(page.locator('#inspector-body h2')).toHaveText('Redis');
  await expect(page.locator('#diagnostics')).toBeHidden();
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await label.click(); await expect(page.locator('#inspector-body h2')).toHaveText('app1');
  await page.getByRole('button', { name: 'Focus selected', exact: true }).click();
  await actionable(label);
  const zoom = await page.locator('#map-zoom').innerText();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#map-zoom')).toHaveText(zoom);
  const center = await sceneCenter(page);
  await page.mouse.move(center.x, center.y); await page.mouse.down();
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await expect(page.locator('#campus')).toHaveAttribute('data-dragging', 'false');
  await page.getByRole('button', { name: 'Fit map', exact: true }).click();
  await label.click(); await expect(page.locator('#inspector-body h2')).toHaveText('app1');
  await page.screenshot({ path: info.outputPath('keyboard-reduced-motion.png') });
});

test.describe('touch navigation', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  test('pinch, changing contacts and cancellation never select a component or request', async ({ page }, info) => {
    await open(page); await pause(page);
    await page.getByLabel('Inspect component', { exact: true }).selectOption('redis');
    const before = await page.locator('#sim-time, #global').allTextContents();
    const c = await sceneCenter(page), client = await page.context().newCDPSession(page);
    const contact = (id: number, x: number, y: number) => ({ id, x, y, radiusX: 2, radiusY: 2 });
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [contact(1, c.x - 45, c.y)] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [contact(1, c.x - 45, c.y), contact(2, c.x + 45, c.y)] });
    for (let step = 1; step <= 4; step++) await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [contact(1, c.x - 45 - step * 10, c.y + step * 3), contact(2, c.x + 45 + step * 10, c.y + step * 3)] });
    await expect.poll(async () => Number.parseInt(await page.locator('#map-zoom').innerText())).toBeGreaterThan(150);
    await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [contact(1, c.x - 85, c.y + 12), contact(2, c.x + 85, c.y + 12), contact(3, c.x, c.y + 60)] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [contact(1, c.x - 85, c.y + 12)] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [contact(1, c.x - 65, c.y + 22)] });
    await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
    await expect(page.locator('#campus')).toHaveAttribute('data-dragging', 'false');
    await expect(page.locator('#inspector-body h2')).toHaveText('Redis');
    await expect(page.locator('#diagnostics')).toBeHidden();
    await page.getByRole('button', { name: 'Fit map', exact: true }).tap();
    await page.locator('[data-scene-component="nginx"]').tap();
    await expect(page.locator('#inspector-body h2')).toHaveText('NGINX');
    expect(await page.locator('#sim-time, #global').allTextContents()).toEqual(before);
    expect(await page.locator('#campus canvas').evaluate(e => getComputedStyle(e).touchAction)).toBe('none');
    expect(await page.locator('#inspector-panel').evaluate(e => getComputedStyle(e).touchAction)).toBe('auto');
    await page.screenshot({ path: info.outputPath('touch-after-pinch.png') });
    await client.detach();
  });
});
