import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      injectRegister: null,
      registerType: 'prompt',
      includeAssets: [
        'icons/apple-touch-icon.png',
        'icons/app-icon-192.png',
        'icons/app-icon-512.png',
        'icons/app-icon-maskable.png',
      ],
      manifest: {
        name: 'Imagine Media Studio',
        short_name: 'Imagine Studio',
        description: 'A lightweight workspace for media generation.',
        lang: 'en',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        background_color: '#f3f3ef',
        theme_color: '#171a19',
        icons: [
          {
            src: '/icons/app-icon-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/app-icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any',
          },
          {
            src: '/icons/app-icon-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        screenshots: [
          {
            src: '/screenshots/pwa-desktop-1280x720.png',
            sizes: '1280x720',
            type: 'image/png',
            form_factor: 'wide',
            label: 'Imagine Media Studio PR 0 desktop App Shell',
          },
          {
            src: '/screenshots/pwa-mobile-390x844.png',
            sizes: '390x844',
            type: 'image/png',
            label: 'Imagine Media Studio PR 0 mobile App Shell',
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{css,html,js,png,svg,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/internal(?:\/|$)/],
      },
    }),
  ],
});
