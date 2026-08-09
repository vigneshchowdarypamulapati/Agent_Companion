import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'Claude Companion',
        short_name: 'Companion',
        start_url: '/',
        display: 'standalone',
        background_color: '#0f172a',
        theme_color: '#0f172a',
      },
      workbox: {
        // The app now has real client-side routes (/sessions/:id); without
        // this, a direct or offline-cached navigation to one falls through
        // to a 404 instead of the SPA shell that client-side routing needs.
        navigateFallback: '/index.html',
      },
    }),
  ],
});
