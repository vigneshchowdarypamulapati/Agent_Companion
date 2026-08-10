/// <reference lib="webworker" />
import { precacheAndRoute, createHandlerBoundToURL } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

// The app has real client-side routes (/sessions/:id, /settings); without this, a direct or
// offline-cached navigation to one falls through to a 404 instead of the SPA shell client-side
// routing needs. Equivalent to the old generateSW config's workbox.navigateFallback: '/index.html'.
registerRoute(new NavigationRoute(createHandlerBoundToURL('/index.html')));

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload: { title: string; body: string; url: string };
  try {
    payload = event.data.json();
  } catch {
    return;
  }
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // Collapses repeat notifications for the same session into one, rather than stacking.
      tag: payload.url,
      data: { url: payload.url },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data as { url: string } | undefined)?.url ?? '/';
  event.waitUntil(
    (async () => {
      const clients = await self.clients.matchAll({ type: 'window' });
      const client = clients.find((c): c is WindowClient => 'focus' in c);
      if (client) {
        if (new URL(client.url).pathname !== url) {
          await client.navigate(url);
        }
        await client.focus();
        return;
      }
      await self.clients.openWindow(url);
    })()
  );
});
