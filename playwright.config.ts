import { resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

const port = 3030;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
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
