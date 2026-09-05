import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: process.env.INTERACTION_BUILD_DIR ?? `/tmp/imagine-interaction-build-${process.pid}`,
    emptyOutDir: false,
    rollupOptions: { input: resolve(import.meta.dirname, 'interaction.html') },
  },
});
