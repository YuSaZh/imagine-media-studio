import { expect, test } from '@playwright/test';

test.describe('PR4 Provider settings', () => {
  test('configures a profile, reports a safe connection failure, and manages a manual model', async ({ page }) => {
    await page.goto('/settings/providers');
    await expect(page.getByRole('heading', { name: 'Providers' })).toBeVisible();

    await page.getByRole('button', { name: 'Add provider' }).click();
    const providerDialog = page.getByRole('dialog');
    await providerDialog.getByLabel('Name').fill('PR4 E2E provider');
    await providerDialog.getByRole('combobox', { name: 'Provider profile' })
      .selectOption('xai-imagine-image-v1');
    await providerDialog.getByLabel('Base URL').fill('https://api.example.test/v1');
    await providerDialog.getByLabel('API key').fill('e2e-key-not-for-upstream');
    await providerDialog.getByRole('button', { name: 'Save provider' }).click();

    const card = page.locator('.provider-card').filter({ hasText: 'PR4 E2E provider' });
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
    await card.getByRole('button', { name: 'Test connection' }).click();
    await expect(card.getByRole('status')).toContainText('Provider connection test failed.');
    await expect(card).not.toContainText('e2e-key-not-for-upstream');

    await card.getByRole('button', { name: 'Add manual model' }).click();
    const modelDialog = page.getByRole('dialog');
    await modelDialog.getByLabel('Model ID').fill('e2e-manual-image');
    await modelDialog.getByLabel('Display name').fill('E2E Manual Image');
    await modelDialog.getByLabel('Capability JSON').fill('{"operations":["image.generate"]}');
    await modelDialog.getByRole('button', { name: 'Save model' }).click();
    await expect(card).toContainText('Manual override');
    await expect(card).toContainText('e2e-manual-image');
  });
});
