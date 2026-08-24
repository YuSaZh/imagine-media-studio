import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@imagine/provider-contract': fileURLToPath(
        new URL('./packages/provider-contract/src/index.ts', import.meta.url),
      ),
      '@imagine/shared': fileURLToPath(
        new URL('./packages/shared/src/index.ts', import.meta.url),
      ),
      '@imagine/testkit': fileURLToPath(
        new URL('./packages/testkit/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    environment: 'node',
    include: ['apps/**/src/**/*.test.{ts,tsx}', 'packages/**/src/**/*.test.{ts,tsx}'],
  },
});
