# PWA Icon Set — Design

## Problem

`packages/web/vite.config.ts`'s `VitePWA` manifest has no `icons` array at
all, and there is no `public/` folder — no favicon, no apple-touch-icon,
no manifest icons of any kind. This is the last item in the Wave 2
production-hardening roadmap. The app just finished a warm-theme restyle
(`packages/web/src/index.css`'s `@theme` block); the icon set needs a real
designed mark that matches it, not a placeholder.

## Non-Goals

- No animated/interactive icon (e.g. dynamic badge counts) — a static
  icon set only.
- No light-mode variant — the app is dark-theme-only (see the warm-theme
  design), so one icon treatment covers it.
- No regeneration pipeline wired into the build — icons change rarely;
  generating once and committing the PNGs is simpler and correct for this
  project's scale (same reasoning as the rest of this codebase's "no
  unnecessary tooling" bias).

## Icon Design

**Concept: Companion Orbit** — a solid cream dot (the primary Claude Code
session) with a smaller cream satellite dot on a thin orbiting ring,
representing a companion device watching over the main session. Chosen
over two alternatives (a literal terminal-prompt chevron, and a "live
pulse" motif echoing the app's own connection-status badge) via visual
review — the orbit reads as more distinctly "Companion" rather than
generic "developer tool," and the concept survives simplification to
favicon scale better than initially expected once the ring weight was
tuned (see below).

Two source SVGs are needed because a single mark cannot serve both a
512px app icon and a 16px browser-tab favicon well — the thin orbit ring
that reads clearly at large sizes turns to visual mush at 16px. Both use
the app's actual warm-theme colors: background `#a8532f` (`--color-accent`),
mark `#f6f0e8` (`--color-ink`).

**Full mark** (`packages/web/src/assets/icon-source.svg`) — used for all
app-icon-scale outputs (192px, 512px, maskable, apple-touch-icon):

```svg
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" fill="#a8532f"/>
  <circle cx="50" cy="50" r="16" fill="#f6f0e8"/>
  <ellipse cx="50" cy="50" rx="34" ry="20" fill="none" stroke="#f6f0e8" stroke-width="4" transform="rotate(-25 50 50)"/>
  <circle cx="79" cy="38" r="7" fill="#f6f0e8" transform="rotate(-25 50 50)"/>
</svg>
```

**Favicon mark** (`packages/web/src/assets/favicon-source.svg`) — used
only for the 16px/32px browser-tab favicon. Same composition, ring
stroke and dot sizes bumped up (4 → 5.5, 16 → 16.5, 7 → 8.5) so the ring
stays a visible ring rather than blurring into a solid blob at tiny
sizes — confirmed by direct visual comparison at 16px against a heavier
(stroke 8) and lighter (stroke 4) alternative:

```svg
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" fill="#a8532f"/>
  <circle cx="50" cy="50" r="16.5" fill="#f6f0e8"/>
  <ellipse cx="50" cy="50" rx="34" ry="20" fill="none" stroke="#f6f0e8" stroke-width="5.5" transform="rotate(-25 50 50)"/>
  <circle cx="79" cy="38" r="8.5" fill="#f6f0e8" transform="rotate(-25 50 50)"/>
</svg>
```

**Maskable variant** — Android's adaptive-icon system can crop up to
~33% of a maskable icon from the edges depending on device mask shape
(circle, squircle, rounded square, ...). The full mark's orbit ring
already extends close to the canvas edge, so it needs its own layout: the
same content scaled to 70% and centered (well inside the ~66%-diameter
safe zone Android's spec requires), with the terracotta background still
bleeding to all four edges (only the background is allowed to bleed —
the mark itself must stay centered):

```svg
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <rect width="100" height="100" fill="#a8532f"/>
  <g transform="translate(50,50) scale(0.7) translate(-50,-50)">
    <circle cx="50" cy="50" r="16" fill="#f6f0e8"/>
    <ellipse cx="50" cy="50" rx="34" ry="20" fill="none" stroke="#f6f0e8" stroke-width="4" transform="rotate(-25 50 50)"/>
    <circle cx="79" cy="38" r="7" fill="#f6f0e8" transform="rotate(-25 50 50)"/>
  </g>
</svg>
```

This is generated as its own file
(`packages/web/src/assets/icon-maskable-source.svg`), not derived
programmatically at generation time — keeping all three source SVGs as
plain committed files means the generation script has no layout logic of
its own, only rasterization.

## Generation Approach

Project memory suggested `@vite-pwa/assets-generator` (the standard
companion tool for `vite-plugin-pwa`), but that tool is built around
deriving every output from one source image scaled down — it has no way
to swap in the separately-tuned favicon mark designed above, and using it
here would silently throw away the 16px legibility fix. Instead: a small
one-time Node script using `sharp` (industry-standard raster library,
prebuilt binaries, no native build step, no Docker) rasterizes the three
source SVGs above into the exact PNG sizes needed. The script is run once
by hand during implementation; its outputs are committed as static files
in `packages/web/public/` — icons change rarely enough that build-time
regeneration would be unnecessary machinery for this project's scale.

No legacy `.ico` file: modern `<link rel="icon" type="image/svg+xml">`
plus PNG fallbacks is current standard practice and every currently
relevant browser supports it, avoiding an extra ICO-packing dependency
for a format only very old IE required.

### Generated files (`packages/web/public/`)

| File | Size | Source | Purpose |
|---|---|---|---|
| `favicon.svg` | vector | favicon-source.svg (copied as-is) | Browser tab icon, modern browsers |
| `favicon-32x32.png` | 32×32 | favicon-source.svg | Browser tab icon fallback |
| `favicon-16x16.png` | 16×16 | favicon-source.svg | Browser tab icon fallback |
| `apple-touch-icon.png` | 180×180 | icon-source.svg | iOS home screen |
| `pwa-192x192.png` | 192×192 | icon-source.svg | Web app manifest (`purpose: any`) |
| `pwa-512x512.png` | 512×512 | icon-source.svg | Web app manifest (`purpose: any`) |
| `maskable-icon-512x512.png` | 512×512 | icon-maskable-source.svg | Web app manifest (`purpose: maskable`) |

### `packages/web/scripts/generate-icons.mjs`

A standalone script (not part of the Vite build) using `sharp` to render
each source SVG at its target size(s) into `public/`. Takes no arguments,
run via `node scripts/generate-icons.mjs` from `packages/web/`. `sharp`
is added as a `devDependency` of `packages/web` (build-time only tool,
not shipped).

## Wiring

**`packages/web/index.html`** — add favicon and apple-touch-icon
`<link>` tags to `<head>` (the `injectManifest` PWA strategy this project
already uses does not auto-inject these, unlike `generateSW` with
`pwaAssets` configured):

```html
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="icon" href="/favicon-32x32.png" sizes="32x32" type="image/png" />
<link rel="icon" href="/favicon-16x16.png" sizes="16x16" type="image/png" />
<link rel="apple-touch-icon" href="/apple-touch-icon.png" />
```

**`packages/web/vite.config.ts`** — add an `icons` array to the existing
`manifest` object (between `background_color`/`theme_color`, unchanged,
and the closing brace):

```ts
icons: [
  { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
  { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
  { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
],
```

## Testing Strategy

This is static-asset generation and markup, not application logic — no
new unit tests. Verification is: the generation script runs successfully
and produces all 7 files at the correct pixel dimensions (checked via
`sharp`'s own metadata read-back, asserted in the script itself rather
than a separate test file, since the script's whole job is producing
these files correctly); the existing web build (`npm run build -w
@companion/web`) succeeds with the new manifest icons; and a manual
check that the favicon renders in a browser tab and the manifest icons
appear correctly (e.g. via Chrome DevTools' Application > Manifest
panel).

## Global Constraints

- Exactly three source SVGs, each committed to
  `packages/web/src/assets/`: `icon-source.svg` (full mark),
  `favicon-source.svg` (favicon-tuned mark), `icon-maskable-source.svg`
  (safe-zone-padded mark) — with the exact SVG markup given above.
- Generation uses `sharp` via a one-time script, not
  `@vite-pwa/assets-generator` and not a build-time step.
- No `.ico` file is generated or referenced.
- All 7 files listed in the Generated Files table must exist in
  `packages/web/public/` at their specified sizes after implementation.
