import { resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const port = 3030;
const baseURL = `http://127.0.0.1:${port}`;
const localChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const localLaunchOptions = localChromium
  ? { launchOptions: { executablePath: localChromium } }
  : {};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL,
    ...localLaunchOptions,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'pr1-desktop-1920x1080',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        viewport: { width: 1920, height: 1080 },
      },
    },
    {
      name: 'pr1-desktop-1440x900',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'pr1-mobile-430x932',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 430, height: 932 },
      },
    },
    {
      name: 'pr1-mobile-390x844',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @imagine/server start',
    env: {
      APP_PORT: String(port),
      DATA_DIR: resolve('/tmp/imagine-media-studio-e2e-data'),
      MOCK_PROVIDER_ENABLED: 'true',
      WEB_DIST_DIR: resolve('apps/web/dist'),
    },
    reuseExistingServer: false,
    timeout: 30_000,
    url: `${baseURL}/internal/health`,
  },
});
