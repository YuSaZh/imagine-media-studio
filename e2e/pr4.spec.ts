import { randomUUID } from 'node:crypto';

import { expect, test } from './fixtures.js';

test.describe('PR4 Provider settings', () => {
  test('configures a profile, reports a safe connection failure, and manages a manual model', async ({ page }) => {
    const runId = randomUUID().slice(0, 8);
    const providerName = `PR4 E2E provider ${runId}`;
    const modelId = `e2e-manual-image-${runId}`;

    await page.goto('/settings/providers');
    await expect(page.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'Add provider', exact: true }).click();
    const providerDialog = page.getByRole('dialog');
    await providerDialog.getByLabel('Name', { exact: true }).fill(providerName);
    await providerDialog.getByRole('combobox', { name: 'Provider profile', exact: true })
      .selectOption('xai-imagine-image-v1');
    await providerDialog.getByLabel('Base URL', { exact: true }).fill('https://api.example.test/v1');
    await providerDialog.getByLabel('API key', { exact: true }).fill('e2e-key-not-for-upstream');
    await providerDialog.getByRole('button', { name: 'Save provider', exact: true }).click();

    const card = page.locator('.provider-card').filter({ hasText: providerName });
    await expect(card).toBeVisible();
    await expect(card).toContainText('API key stored');

    await page.route('**/internal/providers/*/test', async (route) => {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'provider_unavailable',
          message: 'Provider connection test failed.',
        }),
      });
    });
    await card.getByRole('button', { name: 'Test connection', exact: true }).click();
    await expect(card.getByRole('status')).toContainText('Provider connection test failed.');
    await expect(card).not.toContainText('e2e-key-not-for-upstream');

    await card.getByRole('button', { name: 'Add manual model', exact: true }).click();
    const modelDialog = page.getByRole('dialog');
    await modelDialog.getByLabel('Model ID', { exact: true }).fill(modelId);
    await modelDialog.getByLabel('Display name', { exact: true }).fill(`E2E Manual Image ${runId}`);
    await modelDialog.getByLabel('Capability JSON', { exact: true }).fill('{"operations":["image.generate"]}');
    await modelDialog.getByRole('button', { name: 'Save model', exact: true }).click();
    await expect(card).toContainText('Manual override');
    await expect(card).toContainText(modelId);
  });
});
