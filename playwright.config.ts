import { resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { E2E_BASE_URL, E2E_DATA_DIR, E2E_PASSWORD, E2E_PORT, E2E_STORAGE_STATE } from './e2e/runtime.js';

const viewports = [[1920, 1080], [1440, 900], [1280, 800], [1024, 1366], [834, 1194], [430, 932], [390, 844], [360, 800]] as const;
export default defineConfig({
  testDir: './e2e', testMatch: '**/workspace.spec.ts', fullyParallel: false, workers: 1,
  forbidOnly: Boolean(process.env.CI), retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  globalSetup: resolve('e2e/global-setup.ts'), globalTeardown: resolve('e2e/global-teardown.ts'),
  use: { baseURL: E2E_BASE_URL, storageState: E2E_STORAGE_STATE, trace: 'retain-on-failure', serviceWorkers: 'block',
    ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } } : {}) },
  expect: { toHaveScreenshot: { pathTemplate: '{testDir}/visual-baselines/workspace/{projectName}/{arg}{ext}' } },
  projects: viewports.map(([width, height]) => ({ name: `workspace-${width}x${height}`, use: {
    ...devices['Desktop Chrome'], viewport: { width, height }, deviceScaleFactor: 1,
    hasTouch: width < 1100, isMobile: width < 1100, colorScheme: 'light', locale: 'zh-CN', timezoneId: 'UTC',
  } })),
  webServer: { command: 'pnpm --filter @imagine/server start', reuseExistingServer: false, timeout: 30000,
    url: `${E2E_BASE_URL}/internal/health`, env: { APP_PORT: String(E2E_PORT), APP_PASSWORD: E2E_PASSWORD,
      DATA_DIR: E2E_DATA_DIR, MOCK_PROVIDER_ENABLED: 'true', WEB_DIST_DIR: resolve('apps/web/dist') } },
});
