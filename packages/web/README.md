# @companion/web

Mobile-first PWA for monitoring and controlling an active Claude Code
session started through the Companion daemon, from any browser.

## Run

    npm run dev       # local dev server
    npm run build     # type-check + production build
    npm run preview   # preview the production build

## Configuration

The relay's base URL is read from `VITE_RELAY_HTTP_URL` / `VITE_RELAY_WS_URL`
at build time (see `src/config.ts`, added in a later task of this plan).

## Follow-up (not in this plan)

- Real PWA icon set (`vite.config.ts`'s `manifest.icons` is currently empty).
- Web Push notifications — the relay doesn't implement delivery yet.
