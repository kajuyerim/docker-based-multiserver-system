import { defineConfig } from '@playwright/test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const digest = (path: string): string => {
  const hash = createHash('sha256');
  for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(path, entry.name);
    hash.update(entry.name).update(entry.isDirectory() ? digest(file) : readFileSync(file));
  }
  return hash.digest('hex');
};

export default defineConfig({
  testDir: './browser',
  timeout: 60_000,
  globalTimeout: 300_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'test-results/results.json' }]],
  metadata: {
    revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    sourceSHA256: digest('src'),
    bundleSHA256: digest('dist'),
    lockSHA256: createHash('sha256').update(readFileSync('package-lock.json')).digest('hex'),
  },
  use: {
    baseURL: 'http://127.0.0.1:4173/docker-based-multiserver-system/',
    viewport: { width: 1280, height: 720 },
    actionTimeout: 8_000,
    navigationTimeout: 15_000,
    screenshot: 'only-on-failure',
    trace: { mode: 'retain-on-failure', screenshots: false },
  },
  projects: [
    { name: 'chromium', use: { browserName: 'chromium', launchOptions: {
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    } } },
    { name: 'webkit-desktop', testMatch: 'smoke.spec.ts', use: { browserName: 'webkit' } },
    { name: 'webkit-phone', testMatch: 'smoke.spec.ts', use: {
      browserName: 'webkit', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    } },
  ],
  webServer: {
    command: 'npm run preview -- --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173/docker-based-multiserver-system/',
    reuseExistingServer: false,
    timeout: 15_000,
  },
});
