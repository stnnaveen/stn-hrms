import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// v1 ships as an installable PWA (Add to Home Screen).
// v2 wraps this same build with Capacitor for the stores; only src/device/* changes.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/apple-touch-icon.png', 'icons/favicon.svg'],
      manifest: {
        name: 'StartupTN HR',
        short_name: 'STN HR',
        description: 'Selfie check-in, OD and leave for StartupTN staff.',
        theme_color: '#0B1220',
        background_color: '#EDEDEF',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
        ]
      },
      workbox: {
        navigateFallback: '/index.html',
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'],
        runtimeCaching: [
          {
            // MediaPipe face model and wasm: cache once, reuse offline
            urlPattern: /^https:\/\/(cdn\.jsdelivr\.net|storage\.googleapis\.com)\/.*/,
            handler: 'CacheFirst',
            options: { cacheName: 'face-model', expiration: { maxEntries: 20, maxAgeSeconds: 60 * 60 * 24 * 60 } }
          }
        ]
      }
    })
  ],
  server: { host: true }
});
