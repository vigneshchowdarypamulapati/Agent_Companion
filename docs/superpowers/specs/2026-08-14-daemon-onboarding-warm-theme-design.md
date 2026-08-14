# Daemon Onboarding Empty-State + Warm Theme — Design

## Problem

A first-time user who just signed up and registered their browser lands on
the Sessions screen with nothing but "No active sessions." — no hint that
they still need to run the Companion daemon on their own machine and pair
it. The only path to pairing is buried in Settings, several taps away from
where the confusion actually happens.

Separately, the entire web app uses Tailwind's stock cool blue-gray
palette (`slate`/`blue`/`red`/`green`/`amber`) with zero theme
customization — every component references raw Tailwind color utilities
directly. The product should feel warm, soothing, and natural instead.

## Non-Goals

- No device-management UI (viewing/unpairing other devices) — unchanged
  from the multi-user hosting design.
- No richer daemon-status payload (device name, last-seen, etc.) — a
  boolean "is a daemon paired to this account" is all the UI needs.
- No interactive/animated theming (light-mode toggle, per-user theme
  choice) — one warm dark palette, applied globally.
- No changes to the daemon's own pairing mechanics (`request-code` /
  `claim` / `poll`) — this only changes how the browser presents that
  existing flow to a first-time user.

## Part 1 — Daemon Onboarding Empty State

### Backend: `GET /devices/daemon-status`

New route in `packages/relay/src/server.ts`, inserted after the existing
`GET /devices/me` handler, following its exact auth pattern:

```ts
app.get(
  '/devices/daemon-status',
  asyncHandler(async (req, res) => {
    const device = await authenticate(req, pairing);
    if (!device) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const daemon = await store.getDaemonDeviceForUser(device.userId);
    res.status(200).json({ paired: daemon !== undefined });
  })
);
```

`store.getDaemonDeviceForUser` already exists (`packages/relay/src/store.ts:60`)
and is already used by `/pairing/claim` to enforce one-daemon-per-account —
this route is a thin, read-only wrapper around it. No new `Store` method,
no schema change.

### Web: a purpose-built onboarding component, not the reused Settings form

`packages/web/src/SettingsScreen.tsx` already has a compact "Pair a
daemon" form (code entry + submit), meant for a returning user who already
understands the product and just wants to pair a replacement daemon. A
first-time user staring at an empty dashboard needs more: what to do,
why, and reassurance that a 6-digit code they haven't seen yet is normal
and time-limited.

New component `packages/web/src/DaemonOnboarding.tsx` — a self-contained
"get started" flow, independent from `SettingsScreen`'s form (both call
the same underlying `claimPairingCode` from `api/pairing.ts`, since that's
the actual network operation, not UI):

```tsx
import { useState, type FormEvent } from 'react';
import { claimPairingCode } from './api/pairing';
import { UnauthorizedError } from './api/sessions';

export interface DaemonOnboardingProps {
  token: string;
  onUnauthorized: () => void;
}

export default function DaemonOnboarding({ token, onUnauthorized }: DaemonOnboardingProps) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [paired, setPaired] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await claimPairingCode(token, code.trim());
      setPaired(true);
    } catch (err) {
      if (err instanceof UnauthorizedError) {
        onUnauthorized();
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (paired) {
    return (
      <div className="bg-panel rounded-md p-4 space-y-1 text-center">
        <p className="font-medium text-ink">Daemon paired</p>
        <p className="text-sm text-ink-muted">Waiting for your first session…</p>
      </div>
    );
  }

  return (
    <div className="bg-panel rounded-md p-4 space-y-4">
      <div className="space-y-1">
        <h2 className="font-medium text-ink">Connect your daemon</h2>
        <p className="text-sm text-ink-muted">
          Companion controls Claude Code sessions through a small daemon that runs on your machine.
        </p>
      </div>
      <ol className="text-sm text-ink-muted space-y-1 list-decimal list-inside">
        <li>Start the Companion daemon on the machine you run Claude Code on.</li>
        <li>It prints a 6-digit code in the terminal.</li>
        <li>Enter that code below — it expires after 5 minutes, so just restart the daemon for a fresh one if it does.</li>
      </ol>
      <form onSubmit={handleSubmit} className="space-y-3">
        <label htmlFor="onboarding-pairing-code" className="block text-sm text-ink-muted">
          Pairing code
        </label>
        <input
          id="onboarding-pairing-code"
          name="onboarding-pairing-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          className="w-full rounded-md bg-canvas px-3 py-2 tracking-widest"
        />
        <button
          type="submit"
          disabled={busy || code.trim().length === 0}
          className="w-full rounded-md bg-accent hover:bg-accent-hover px-3 py-2 font-medium disabled:opacity-50"
        >
          {busy ? 'Pairing…' : 'Pair daemon'}
        </button>
        {error && (
          <p role="alert" className="text-sm text-danger-light">
            {error}
          </p>
        )}
      </form>
    </div>
  );
}
```

### Wiring it into `SessionList.tsx`

`SessionList` currently takes no props (reads everything from
`useSessions()` context) and renders `{sorted.length === 0 && <p>No
active sessions.</p>}`. It needs a `token` prop (App.tsx already holds
`credentials.token` and passes it to `SessionDetail`/`SettingsScreen` the
same way) and an `onUnauthorized` prop, to:

1. Add `getDaemonStatus(token): Promise<boolean>` to
   `packages/web/src/api/devices.ts`, same shape as `getDevice`:

   ```ts
   export async function getDaemonStatus(token: string): Promise<boolean> {
     const res = await fetch(`${RELAY_HTTP_URL}/devices/daemon-status`, {
       headers: { authorization: `Bearer ${token}` },
     });
     if (res.status === 401) throw new UnauthorizedError();
     if (!res.ok) {
       throw new Error(`Failed to fetch daemon status: HTTP ${res.status}`);
     }
     const body = (await res.json()) as { paired: boolean };
     return body.paired;
   }
   ```

2. In `SessionList`, when `sorted.length === 0`, fetch daemon-status once
   (on mount / when the list first becomes empty) into
   `daemonPaired: boolean | undefined`. Render rules for the empty case:
   - `daemonPaired === undefined` (still loading): render nothing extra —
     the fetch is fast and a flash of onboarding-then-plain-text would be
     worse than a brief blank.
   - `daemonPaired === false`: render `<DaemonOnboarding token={token} onUnauthorized={onUnauthorized} />`.
   - `daemonPaired === true`: render the existing `<p className="text-ink-muted">No active sessions.</p>`.
   - On fetch failure (relay hiccup): treat as `false` (fail toward
     showing onboarding) rather than silently falling back to the
     unhelpful blank message — a returning user seeing onboarding
     instructions once is a much smaller cost than a new user hitting a
     dead end with no idea what to do. Swallow the error itself (no
     visible error banner for this one background check), matching the
     existing pattern in `SettingsScreen.tsx`'s `loadPushState`.
   - A real 401 (`UnauthorizedError`) still calls `onUnauthorized` — same
     handling every other authenticated call in this app already has.
   - No re-fetch loop: once a real session appears (`sorted.length > 0`),
     the branch stops rendering and the fetch is not repeated. If the
     account already had a daemon and the user reloads mid-onboarding,
     the fresh fetch correctly reflects `paired: true`.

`App.tsx` changes: pass `token={credentials.token}` and
`onUnauthorized={handleUnauthorized}` to `<SessionList />` at its route
(`App.tsx:55`).

## Part 2 — Warm Color Theme

### Approach: semantic design tokens, not raw palette overrides

Every component references raw Tailwind utilities (`bg-slate-900`,
`bg-blue-600`, ...) directly — no `@theme` customization exists yet
(`packages/web/src/index.css` is just `@import "tailwindcss";`).
Hijacking Tailwind's own `slate`/`blue`/`red`/`green` color names to
secretly mean something else would be confusing to read later
(`bg-blue-600` rendering terracotta). Instead, define named semantic
tokens via Tailwind v4's CSS-first `@theme` directive — the standard
pattern for production Tailwind apps — and replace every raw color
utility across all 12 component files with its semantic equivalent. One
place to tune the palette forever after; self-documenting class names
everywhere else.

Naming: `canvas`/`panel` for surfaces and `ink` for text (evoking the
warm, natural brief) rather than generic `background`/`foreground`.

### `packages/web/src/index.css`

```css
@import "tailwindcss";

@theme {
  --color-canvas: #201a16;
  --color-panel: #2d2521;
  --color-border: #4a3d34;

  --color-ink: #f6f0e8;
  --color-ink-secondary: #d3c4b4;
  --color-ink-muted: #ab9686;
  --color-ink-faint: #8a7666;

  --color-accent: #a8532f;
  --color-accent-hover: #8f4426;
  --color-link: #e2905f;

  --color-success: #55684a;
  --color-success-text: #a9c091;

  --color-danger: #9c3f2a;
  --color-danger-hover: #832f1d;
  --color-danger-bg: #3a1f18;
  --color-danger-text: #f3ddd2;
  --color-danger-light: #e08a68;

  --color-warning: #8a6a2c;
  --color-warning-bg: #3a2c12;
}
```

This makes `bg-canvas`, `text-ink`, `bg-accent`, `hover:bg-accent-hover`,
`bg-danger`, `bg-warning-bg/40`, etc. available as ordinary Tailwind
utility classes app-wide, with no other build config changes.

### Full replacement mapping (every occurrence, by file)

Two shades that were serving the same semantic role with no real
distinction (`bg-red-700` and `bg-red-800`, both just "danger button")
collapse to the single `bg-danger` token — a real inconsistency fixed
along the way, not preserved for its own sake. Buttons using the primary
accent or danger colors also gain a `hover:` variant, which did not exist
before anywhere in the app (a small, free polish given every one of these
classNames is already being touched).

| File | Old class | New class |
|---|---|---|
| `App.tsx:40` | `bg-slate-900 text-slate-100` | `bg-canvas text-ink` |
| `BrowserRegistrationGate.tsx:43` | `bg-slate-900 text-slate-100` | `bg-canvas text-ink` |
| `BrowserRegistrationGate.tsx:46` | `text-red-400` | `text-danger-light` |
| `BrowserRegistrationGate.tsx:55` | `bg-blue-600` | `bg-accent hover:bg-accent-hover` |
| `BrowserRegistrationGate.tsx:61` | `text-slate-400` | `text-ink-muted` |
| `SessionList.tsx:32` | `bg-slate-900 text-slate-100` | `bg-canvas text-ink` |
| `SessionList.tsx:36` | `` connected ? 'bg-green-700' : 'bg-red-700' `` | `` connected ? 'bg-success' : 'bg-danger' `` |
| `SessionList.tsx:39` | `text-slate-400` | `text-ink-muted` |
| `SessionList.tsx:46` | `bg-red-900 text-red-100` | `bg-danger-bg text-danger-text` |
| `SessionList.tsx:51` | `text-slate-400` | `text-ink-muted` (this line also becomes the 3-way onboarding/idle/loading branch from Part 1) |
| `SessionList.tsx:55` | `bg-slate-800` | `bg-panel` |
| `SessionList.tsx:61` | `bg-amber-700` | `bg-warning` |
| `SessionList.tsx:64` | `text-slate-400` | `text-ink-muted` |
| `SessionList.tsx:66` | `text-slate-500` | `text-ink-faint` |
| `SessionList.tsx:73` | `bg-slate-700` | `bg-border` |
| `SessionList.tsx:78` | `text-red-400` | `text-danger-light` |
| `SessionDetail.tsx:132` | `text-slate-400` | `text-ink-muted` |
| `SessionDetail.tsx:139` | `bg-slate-900 text-slate-100` | `bg-canvas text-ink` |
| `SessionDetail.tsx:140` | `text-slate-400` | `text-ink-muted` |
| `SessionDetail.tsx:141` | `text-blue-400` | `text-link` |
| `SessionDetail.tsx:151` | `bg-slate-900 text-slate-100` | `bg-canvas text-ink` |
| `SessionDetail.tsx:152` | `text-blue-400` | `text-link` |
| `SessionDetail.tsx:157` | `bg-red-900 text-red-100` | `bg-danger-bg text-danger-text` |
| `SessionDetail.tsx:182` | `text-slate-400` | `text-ink-muted` |
| `SessionDetail.tsx:187` | `text-slate-400` | `text-ink-muted` |
| `SessionStatusBar.tsx:18` | `bg-slate-800` | `bg-panel` |
| `SessionStatusBar.tsx:21` | `text-slate-400` | `text-ink-muted` |
| `SessionStatusBar.tsx:23` | `` connected ? 'bg-green-700' : 'bg-red-700' `` | `` connected ? 'bg-success' : 'bg-danger' `` |
| `PermissionPrompt.tsx:17` | `bg-amber-900/40 border-amber-700` | `bg-warning-bg/40 border-warning` |
| `PermissionPrompt.tsx:19` | `bg-slate-800` | `bg-panel` |
| `PermissionPrompt.tsx:24` | `bg-green-700` | `bg-success` |
| `PermissionPrompt.tsx:31` | `bg-red-700` | `bg-danger` |
| `PromptInjectionBox.tsx:28` | `bg-slate-800` | `bg-panel` |
| `PromptInjectionBox.tsx:33` | `bg-blue-600` | `bg-accent hover:bg-accent-hover` |
| `SessionControls.tsx:20` | `bg-slate-800` | `bg-panel` |
| `SessionControls.tsx:28` | `bg-slate-800` | `bg-panel` |
| `SessionControls.tsx:36` | `bg-red-800` | `bg-danger hover:bg-danger-hover` |
| `ActivityFeed.tsx:9` | `text-slate-500` | `text-ink-faint` |
| `ActivityFeed.tsx:14` | `bg-slate-800` | `bg-panel` |
| `ModifiedFilesPanel.tsx:11` | `text-slate-500` | `text-ink-faint` |
| `ModifiedFilesPanel.tsx:16` | `bg-slate-800` | `bg-panel` |
| `SettingsScreen.tsx:153` | `bg-slate-900 text-slate-100` | `bg-canvas text-ink` |
| `SettingsScreen.tsx:156` | `text-slate-400` | `text-ink-muted` |
| `SettingsScreen.tsx:162` | `bg-red-900 text-red-100` | `bg-danger-bg text-danger-text` |
| `SettingsScreen.tsx:168` | `bg-slate-800` | `bg-panel` |
| `SettingsScreen.tsx:170,171` | `text-slate-400` | `text-ink-muted` |
| `SettingsScreen.tsx:176` | `text-slate-300` | `text-ink-secondary` |
| `SettingsScreen.tsx:177,180` | `text-slate-400` | `text-ink-muted` |
| `SettingsScreen.tsx:192` | `bg-slate-800` | `bg-panel` |
| `SettingsScreen.tsx:197` | `bg-blue-600` | `bg-accent hover:bg-accent-hover` |
| `SettingsScreen.tsx:201` | `text-green-400` | `text-success-text` |
| `SettingsScreen.tsx:203` | `text-red-400` | `text-danger-light` |
| `SettingsScreen.tsx:211` | `text-slate-300` | `text-ink-secondary` |
| `SettingsScreen.tsx:213-216,219` | `text-slate-400` | `text-ink-muted` |
| `SettingsScreen.tsx:224` | `bg-slate-800` | `bg-panel` |
| `SettingsScreen.tsx:234` | `bg-blue-600` | `bg-accent hover:bg-accent-hover` |
| `SettingsScreen.tsx:240` | `text-red-400` | `text-danger-light` |
| `SettingsScreen.tsx:252` | `bg-red-700` | `bg-danger hover:bg-danger-hover` |
| `SettingsScreen.tsx:258` | `text-slate-300` | `text-ink-secondary` |
| `SettingsScreen.tsx:266` | `bg-red-700` | `bg-danger hover:bg-danger-hover` |
| `SettingsScreen.tsx:274` | `bg-slate-800` | `bg-panel` |
| `SettingsScreen.tsx:282` | `text-red-400` | `text-danger-light` |

No component file references a raw Tailwind color utility class after
this change — `grep -rE "(bg|text|border)-(slate|blue|red|green|amber)-[0-9]" packages/web/src` returns nothing.

## Testing Strategy

- `packages/relay/src/server.test.ts`: new tests for `GET
  /devices/daemon-status` — returns `{ paired: false }` for an account
  with no daemon, `{ paired: true }` after pairing one (reusing the
  existing `pairDaemon` test helper), and `401` unauthenticated.
- `packages/web/src/api/devices.test.ts`: new tests for `getDaemonStatus`
  — 200 → boolean, 401 → `UnauthorizedError`, non-401 error → throws.
- `packages/web/src/DaemonOnboarding.test.tsx` (new file): renders the
  instructions and form; submitting calls `claimPairingCode` with the
  entered code; shows the "Daemon paired / waiting for your first
  session" state on success; shows an inline error on failure; calls
  `onUnauthorized` on `UnauthorizedError`.
- `packages/web/src/SessionList.test.tsx`: update the existing empty-state
  test to also mock `getDaemonStatus`; add cases for `paired: false` →
  onboarding renders, `paired: true` → plain "No active sessions."
  renders, and a failed fetch → onboarding renders (fail-open).
- No new tests needed purely for the color-token swap (it's a visual-only
  change) — existing tests that assert on `role="alert"`, text content,
  or button names are unaffected since only `className` values change.

## Global Constraints

- Every raw Tailwind color utility (`slate`/`blue`/`red`/`green`/`amber`)
  is replaced with a semantic token from `@theme` in
  `packages/web/src/index.css` — no component may reference a raw
  Tailwind color class after this change.
- `GET /devices/daemon-status` returns exactly `{ paired: boolean }`, no
  additional fields.
- `DaemonOnboarding` and `SettingsScreen`'s existing pairing form remain
  two separate components — do not merge or extract a shared form
  component between them.
- The onboarding empty-state must never show for an account that already
  has a paired daemon (`paired: true` always renders the plain "No active
  sessions." message), and must fail toward showing onboarding (not
  toward silently hiding it) if the daemon-status check itself fails.
