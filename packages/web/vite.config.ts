import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      // injectManifest (not the default generateSW) is required so src/sw.ts can add its own
      // push/notificationclick listeners — generateSW only ever produces a precaching-only
      // service worker with no hook for custom event handlers. The SPA navigation fallback
      // that used to be configured here via workbox.navigateFallback is now implemented
      // directly in src/sw.ts via workbox-routing's NavigationRoute.
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'autoUpdate',
      manifest: {
        name: 'Claude Companion',
        short_name: 'Companion',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
      },
    }),
  ],
});
