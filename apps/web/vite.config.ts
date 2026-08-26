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
            src: '/screenshots/pwa-desktop-1440x900.png',
            sizes: '1440x900',
            type: 'image/png',
            form_factor: 'wide',
            label: 'Imagine Media Studio desktop gallery and Composer',
          },
          {
            src: '/screenshots/pwa-mobile-390x844-pr1.png',
            sizes: '390x844',
            type: 'image/png',
            label: 'Imagine Media Studio mobile gallery and Composer',
          },
        ],
      },
      workbox: {
        cleanupOutdatedCaches: true,
        globIgnores: ['mock-media/**', 'screenshots/**'],
        globPatterns: ['**/*.{css,html,js,png,svg,webmanifest}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/internal(?:\/|$)/],
        runtimeCaching: [
          {
            urlPattern: ({ request, sameOrigin, url }) => {
              if (!sameOrigin || request.method !== 'GET' || url.search !== '') return false;
              if (
                request.headers.has('authorization') ||
                request.headers.has('proxy-authorization') ||
                request.headers.has('cookie') ||
                request.headers.has('range')
              ) {
                return false;
              }
              return /^\/internal\/assets\/[^/]+\/(?:thumbnail|poster)$/u.test(url.pathname);
            },
            handler: 'CacheFirst',
            method: 'GET',
            options: {
              cacheName: 'imagine-derived-media-v1',
              cacheableResponse: { statuses: [200] },
              expiration: {
                maxAgeSeconds: 7 * 24 * 60 * 60,
                maxEntries: 100,
              },
            },
          },
        ],
      },
    }),
  ],
});
