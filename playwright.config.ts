import { resolve } from 'node:path';

import { defineConfig, devices } from '@playwright/test';

import {
  E2E_BASE_URL,
  E2E_DATA_DIR,
  E2E_PASSWORD,
  E2E_PORT,
  E2E_STORAGE_STATE,
} from './e2e/runtime.js';

const port = E2E_PORT;
const baseURL = E2E_BASE_URL;
const pr6TestMatch = /pr6\.spec\.ts/;
const localChromium = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const localLaunchOptions = localChromium
  ? { launchOptions: { executablePath: localChromium } }
  : {};

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.spec.ts',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  globalSetup: resolve('e2e/global-setup.ts'),
  globalTeardown: resolve('e2e/global-teardown.ts'),
  workers: 1,
  use: {
    baseURL,
    ...localLaunchOptions,
    storageState: E2E_STORAGE_STATE,
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
      testIgnore: pr6TestMatch,
    },
    {
      name: 'pr1-desktop-1440x900',
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        viewport: { width: 1440, height: 900 },
      },
      testIgnore: pr6TestMatch,
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
      testIgnore: pr6TestMatch,
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
      testIgnore: pr6TestMatch,
    },
    {
      name: 'pr6-desktop-1440x900',
      testMatch: pr6TestMatch,
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'pr6-desktop-1920x1080',
      testMatch: pr6TestMatch,
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        viewport: { width: 1920, height: 1080 },
      },
    },
    {
      name: 'pr6-desktop-1280x800',
      testMatch: pr6TestMatch,
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'pr6-tablet-834x1112',
      testMatch: pr6TestMatch,
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 834, height: 1112 },
      },
    },
    {
      name: 'pr6-tablet-1024x1366',
      testMatch: pr6TestMatch,
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 1024, height: 1366 },
      },
    },
    {
      name: 'pr6-mobile-430x932',
      testMatch: pr6TestMatch,
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 430, height: 932 },
      },
    },
    {
      name: 'pr6-mobile-390x844',
      testMatch: pr6TestMatch,
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      },
    },
    {
      name: 'pr6-mobile-360x800',
      testMatch: pr6TestMatch,
      use: {
        ...devices['Desktop Chrome'],
        deviceScaleFactor: 1,
        hasTouch: true,
        isMobile: true,
        viewport: { width: 360, height: 800 },
      },
    },
  ],
  webServer: {
    command: 'pnpm --filter @imagine/server start',
    env: {
      APP_PORT: String(port),
      APP_PASSWORD: E2E_PASSWORD,
      DATA_DIR: E2E_DATA_DIR,
      MOCK_PROVIDER_ENABLED: 'true',
      WEB_DIST_DIR: resolve('apps/web/dist'),
    },
    reuseExistingServer: false,
    timeout: 30_000,
    url: `${baseURL}/internal/health`,
  },
});
