# Daemon Onboarding Empty-State + Warm Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give first-time users a real "get started" flow when their dashboard is empty (instead of a dead-end "No active sessions."), and replace the app's stock cool blue-gray Tailwind palette with a warm, soothing, natural one everywhere.

**Architecture:** A new relay endpoint (`GET /devices/daemon-status`) exposes a boolean built on an existing store method. `SessionList` uses it to decide whether to render a brand-new, purpose-built `DaemonOnboarding` component (deliberately separate from `SettingsScreen`'s existing compact pairing form — different moment, different needs) or the existing plain empty-state text. The color change is a semantic-token layer: new named CSS custom properties in `index.css` via Tailwind v4's `@theme`, with every raw Tailwind color utility across the app swapped for its semantic equivalent.

**Tech Stack:** Express 4 + Zod (relay), React 19 + Vite + Tailwind v4 (web), Vitest + Testing Library + supertest (tests). No new dependencies.

## Global Constraints

- Every raw Tailwind color utility (`slate`/`blue`/`red`/`green`/`amber`) is replaced with a semantic token from `@theme` in `packages/web/src/index.css` — no component may reference a raw Tailwind color class after this plan is complete.
- `GET /devices/daemon-status` returns exactly `{ paired: boolean }`, no additional fields.
- `DaemonOnboarding` and `SettingsScreen`'s existing pairing form remain two separate components — do not merge or extract a shared form component between them. They may both call `claimPairingCode` from `api/pairing.ts` (the same network operation), but their UI/JSX is independent.
- The onboarding empty-state must never show for an account that already has a paired daemon (`paired: true` always renders the plain "No active sessions." message), and must fail toward showing onboarding (not toward silently hiding it) if the daemon-status check itself fails.

---

## Task 1: Warm color theme — semantic tokens + app-wide swap

**Files:**
- Modify: `packages/web/src/index.css`
- Modify: `packages/web/src/App.tsx:40`
- Modify: `packages/web/src/BrowserRegistrationGate.tsx:43,46,55,61`
- Modify: `packages/web/src/SessionList.tsx:32,36,39,46,51,55,61,64,66,73,78`
- Modify: `packages/web/src/SessionDetail.tsx:132,139,140,141,151,152,157,182,187`
- Modify: `packages/web/src/SessionStatusBar.tsx:18,21,23`
- Modify: `packages/web/src/PermissionPrompt.tsx:17,19,24,31`
- Modify: `packages/web/src/PromptInjectionBox.tsx:28,33`
- Modify: `packages/web/src/SessionControls.tsx:20,28,36`
- Modify: `packages/web/src/ActivityFeed.tsx:9,14`
- Modify: `packages/web/src/ModifiedFilesPanel.tsx:11,16`
- Modify: `packages/web/src/SettingsScreen.tsx:153,156,162,168,170,171,176,177,180,192,197,201,203,211,213,214,216,219,224,234,240,252,258,266,274,282`

**Interfaces:**
- Produces: the semantic color classes every later task must use instead of raw Tailwind colors — `bg-canvas`, `bg-panel`, `bg-border`, `border-border`, `text-ink`, `text-ink-secondary`, `text-ink-muted`, `text-ink-faint`, `bg-accent`, `hover:bg-accent-hover`, `text-link`, `bg-success`, `text-success-text`, `bg-danger`, `hover:bg-danger-hover`, `bg-danger-bg`, `text-danger-text`, `text-danger-light`, `bg-warning`, `bg-warning-bg`.

This task touches every existing component file but makes no behavioral change — only `className` strings change. No new tests are needed (existing tests assert on text content, roles, and button names, never on color classes); the existing full web test suite passing unchanged is the verification, plus a grep check that zero raw color classes remain.

- [ ] **Step 1: Add the semantic theme tokens**

Replace the entire contents of `packages/web/src/index.css` (currently just `@import "tailwindcss";`) with:

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

This makes `bg-canvas`, `text-ink`, `bg-accent`, `hover:bg-accent-hover`, `bg-warning-bg/40`, etc. available as ordinary Tailwind utility classes everywhere, with no other build config changes needed (Tailwind v4 auto-generates utilities from any `--color-*` variable in `@theme`).

- [ ] **Step 2: Apply the exact class replacements below, file by file**

For each file, use the Edit tool to replace every occurrence of the old class string with the new one, exactly as listed. Where a line has more than one color class, replace all of them on that line in one edit.

**`App.tsx`** (line 40):
- `bg-slate-900 text-slate-100` → `bg-canvas text-ink`

**`BrowserRegistrationGate.tsx`**:
- line 43: `bg-slate-900 text-slate-100` → `bg-canvas text-ink`
- line 46: `text-red-400` → `text-danger-light`
- line 55: `bg-blue-600` → `bg-accent hover:bg-accent-hover`
- line 61: `text-slate-400` → `text-ink-muted`

**`SessionList.tsx`**:
- line 32: `bg-slate-900 text-slate-100` → `bg-canvas text-ink`
- line 36: `connected ? 'bg-green-700' : 'bg-red-700'` → `connected ? 'bg-success' : 'bg-danger'`
- line 39: `text-slate-400` → `text-ink-muted`
- line 46: `bg-red-900 text-red-100` → `bg-danger-bg text-danger-text`
- line 51: `text-slate-400` → `text-ink-muted`
- line 55: `bg-slate-800` → `bg-panel`
- line 61: `bg-amber-700` → `bg-warning`
- line 64: `text-slate-400` → `text-ink-muted`
- line 66: `text-slate-500` → `text-ink-faint`
- line 73: `bg-slate-700` → `bg-border`
- line 78: `text-red-400` → `text-danger-light`

**`SessionDetail.tsx`**:
- line 132: `text-slate-400` → `text-ink-muted`
- line 139: `bg-slate-900 text-slate-100` → `bg-canvas text-ink`
- line 140: `text-slate-400` → `text-ink-muted`
- line 141: `text-blue-400` → `text-link`
- line 151: `bg-slate-900 text-slate-100` → `bg-canvas text-ink`
- line 152: `text-blue-400` → `text-link`
- line 157: `bg-red-900 text-red-100` → `bg-danger-bg text-danger-text`
- line 182: `text-slate-400` → `text-ink-muted`
- line 187: `text-slate-400` → `text-ink-muted`

**`SessionStatusBar.tsx`**:
- line 18: `bg-slate-800` → `bg-panel`
- line 21: `text-slate-400` → `text-ink-muted`
- line 23: `connected ? 'bg-green-700' : 'bg-red-700'` → `connected ? 'bg-success' : 'bg-danger'`

**`PermissionPrompt.tsx`**:
- line 17: `bg-amber-900/40 border border-amber-700` → `bg-warning-bg/40 border border-warning`
- line 19: `bg-slate-800` → `bg-panel`
- line 24: `bg-green-700` → `bg-success`
- line 31: `bg-red-700` → `bg-danger`

**`PromptInjectionBox.tsx`**:
- line 28: `bg-slate-800` → `bg-panel`
- line 33: `bg-blue-600` → `bg-accent hover:bg-accent-hover`

**`SessionControls.tsx`**:
- line 20: `bg-slate-800` → `bg-panel`
- line 28: `bg-slate-800` → `bg-panel`
- line 36: `bg-red-800` → `bg-danger hover:bg-danger-hover`

**`ActivityFeed.tsx`**:
- line 9: `text-slate-500` → `text-ink-faint`
- line 14: `bg-slate-800` → `bg-panel`

**`ModifiedFilesPanel.tsx`**:
- line 11: `text-slate-500` → `text-ink-faint`
- line 16: `bg-slate-800` → `bg-panel`

**`SettingsScreen.tsx`**:
- line 153: `bg-slate-900 text-slate-100` → `bg-canvas text-ink`
- line 156: `text-slate-400` → `text-ink-muted`
- line 162: `bg-red-900 text-red-100` → `bg-danger-bg text-danger-text`
- line 168: `bg-slate-800` → `bg-panel`
- line 170: `text-slate-400` → `text-ink-muted`
- line 171: `text-slate-400` → `text-ink-muted`
- line 176: `text-slate-300` → `text-ink-secondary`
- line 177: `text-slate-400` → `text-ink-muted`
- line 180: `text-slate-400` → `text-ink-muted`
- line 192: `bg-slate-800` → `bg-panel`
- line 197: `bg-blue-600` → `bg-accent hover:bg-accent-hover`
- line 201: `text-green-400` → `text-success-text`
- line 203: `text-red-400` → `text-danger-light`
- line 211: `text-slate-300` → `text-ink-secondary`
- line 213: `text-slate-400` → `text-ink-muted`
- line 214: `text-slate-400` → `text-ink-muted`
- line 216: `text-slate-400` → `text-ink-muted`
- line 219: `text-slate-400` → `text-ink-muted`
- line 224: `bg-slate-800` → `bg-panel`
- line 234: `bg-blue-600` → `bg-accent hover:bg-accent-hover`
- line 240: `text-red-400` → `text-danger-light`
- line 252: `bg-red-700` → `bg-danger hover:bg-danger-hover`
- line 258: `text-slate-300` → `text-ink-secondary`
- line 266: `bg-red-700` → `bg-danger hover:bg-danger-hover`
- line 274: `bg-slate-800` → `bg-panel`
- line 282: `text-red-400` → `text-danger-light`

Line numbers above are from the file states at spec time — if a file has shifted slightly, locate the same class strings by content, not by exact line number.

- [ ] **Step 3: Verify no raw Tailwind color classes remain**

Run: `grep -rE "(bg|text|border)-(slate|blue|red|green|amber)-[0-9]" packages/web/src --include="*.tsx"`
Expected: no output (zero matches).

- [ ] **Step 4: Run the full web test suite to confirm zero regressions**

Run: `npm test -w @companion/web`
Expected: all existing tests still pass (159 tests, 25 files, before this task).

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/index.css packages/web/src/App.tsx packages/web/src/BrowserRegistrationGate.tsx packages/web/src/SessionList.tsx packages/web/src/SessionDetail.tsx packages/web/src/SessionStatusBar.tsx packages/web/src/PermissionPrompt.tsx packages/web/src/PromptInjectionBox.tsx packages/web/src/SessionControls.tsx packages/web/src/ActivityFeed.tsx packages/web/src/ModifiedFilesPanel.tsx packages/web/src/SettingsScreen.tsx
git commit -m "style: replace stock Tailwind palette with a warm semantic theme"
```

---

## Task 2: Relay — `GET /devices/daemon-status`

**Files:**
- Modify: `packages/relay/src/server.ts` (add route after the existing `GET /devices/me` handler)
- Test: `packages/relay/src/server.test.ts`

**Interfaces:**
- Consumes: `store.getDaemonDeviceForUser(userId: string): Promise<Device | undefined>` (already exists, `packages/relay/src/store.ts:60`); `authenticate(req, pairing): Promise<Device | undefined>` (already exists in `server.ts`, used by every other authenticated route).
- Produces: `GET /devices/daemon-status` → `200 { paired: boolean }` when authenticated, `401 { error: 'Unauthorized' }` otherwise. Task 3 (the web API client) depends on this exact response shape.

- [ ] **Step 1: Write the failing tests**

Add to `packages/relay/src/server.test.ts`, directly after the existing `'returns 404 for an unknown session id when authenticated'` test block (or any convenient spot after the other `describe`-level tests — this project uses a flat `it(...)` list inside one `describe('relay server', ...)`, matching the existing style):

```ts
  it('GET /devices/daemon-status returns paired: false when the account has no daemon', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const browserToken = await registerBrowser(httpServer, 'my-browser');

    const res = await request(httpServer)
      .get('/devices/daemon-status')
      .set('Authorization', `Bearer ${browserToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paired: false });
  });

  it('GET /devices/daemon-status returns paired: true once a daemon is paired to the account', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const browserToken = await registerBrowser(httpServer, 'my-browser');
    await pairDaemon(httpServer, browserToken, 'my-daemon');

    const res = await request(httpServer)
      .get('/devices/daemon-status')
      .set('Authorization', `Bearer ${browserToken}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ paired: true });
  });

  it('GET /devices/daemon-status returns 401 when unauthenticated', async () => {
    httpServer = await createRelayServer({
      store: new InMemoryStore(),
      pubsub: new InMemoryPubSub(),
      identityVerifier: makeIdentityVerifier(),
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));

    const res = await request(httpServer).get('/devices/daemon-status');

    expect(res.status).toBe(401);
  });
```

This file already imports `InMemoryStore`, `InMemoryPubSub`, `request` (supertest), and defines the `registerBrowser` and `pairDaemon` helpers used above — no new imports needed.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/relay -- server.test.ts`
Expected: the 3 new tests FAIL with 404 (route doesn't exist yet).

- [ ] **Step 3: Implement the route**

In `packages/relay/src/server.ts`, insert this route immediately after the closing `);` of the existing `app.get('/devices/me', ...)` handler (currently ending at line 280) and before `app.post('/devices/unpair', ...)`:

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @companion/relay -- server.test.ts`
Expected: all tests pass, including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/relay/src/server.ts packages/relay/src/server.test.ts
git commit -m "feat(relay): add GET /devices/daemon-status"
```

---

## Task 3: Web — `getDaemonStatus` API client

**Files:**
- Modify: `packages/web/src/api/devices.ts`
- Test: `packages/web/src/api/devices.test.ts`

**Interfaces:**
- Consumes: `GET /devices/daemon-status` from Task 2, response `{ paired: boolean }`. `RELAY_HTTP_URL` (existing import from `../config`), `UnauthorizedError` (existing import from `./sessions`).
- Produces: `getDaemonStatus(token: string): Promise<boolean>`, exported from `packages/web/src/api/devices.ts`. Task 5 (`SessionList`) depends on this exact name and signature.

- [ ] **Step 1: Write the failing tests**

Add to `packages/web/src/api/devices.test.ts`, inside the existing `describe('devices API', ...)` block (add `getDaemonStatus` to the existing import line at the top of the file):

```ts
import { getDevice, unpairDevice, registerBrowserDevice, getDaemonStatus } from './devices';
```

```ts
  it('getDaemonStatus returns true when the relay reports paired: true', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ paired: true }) })));
    await expect(getDaemonStatus('tok-1')).resolves.toBe(true);
  });

  it('getDaemonStatus returns false when the relay reports paired: false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ paired: false }) })));
    await expect(getDaemonStatus('tok-1')).resolves.toBe(false);
  });

  it('getDaemonStatus throws UnauthorizedError on 401', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({}) })));
    await expect(getDaemonStatus('bad-token')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('getDaemonStatus throws on a non-401 error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    await expect(getDaemonStatus('tok-1')).rejects.toThrow('HTTP 500');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/web -- api/devices.test.ts`
Expected: the 4 new tests FAIL (`getDaemonStatus` is not exported yet).

- [ ] **Step 3: Implement `getDaemonStatus`**

Add to `packages/web/src/api/devices.ts`, after the existing `unpairDevice` function:

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @companion/web -- api/devices.test.ts`
Expected: all tests pass, including the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/api/devices.ts packages/web/src/api/devices.test.ts
git commit -m "feat(web): add getDaemonStatus API client"
```

---

## Task 4: Web — `DaemonOnboarding` component

**Files:**
- Create: `packages/web/src/DaemonOnboarding.tsx`
- Test: `packages/web/src/DaemonOnboarding.test.tsx`

**Interfaces:**
- Consumes: `claimPairingCode(token: string, code: string): Promise<void>` (existing, `packages/web/src/api/pairing.ts`), `UnauthorizedError` (existing, `packages/web/src/api/sessions.ts`). Semantic theme classes from Task 1 (`bg-panel`, `text-ink`, `text-ink-muted`, `bg-canvas`, `bg-accent`, `hover:bg-accent-hover`, `text-danger-light`).
- Produces: `export default function DaemonOnboarding({ token, onUnauthorized }: DaemonOnboardingProps)`, where `DaemonOnboardingProps = { token: string; onUnauthorized: () => void }`. Task 5 (`SessionList`) renders this component with these exact prop names.

This component is deliberately independent from `SettingsScreen.tsx`'s existing "Pair a daemon" form — do not extract or share UI between them (Global Constraints). Both call `claimPairingCode`, which is the only thing they share.

- [ ] **Step 1: Write the failing tests**

Create `packages/web/src/DaemonOnboarding.test.tsx`:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DaemonOnboarding from './DaemonOnboarding';
import * as pairingApi from './api/pairing';
import { UnauthorizedError } from './api/sessions';

function renderOnboarding(token = 'tok-1', onUnauthorized = vi.fn()) {
  render(<DaemonOnboarding token={token} onUnauthorized={onUnauthorized} />);
  return onUnauthorized;
}

describe('DaemonOnboarding', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows get-started instructions and a pairing code form', () => {
    renderOnboarding();
    expect(screen.getByText('Connect your daemon')).toBeInTheDocument();
    expect(screen.getByLabelText('Pairing code')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pair daemon' })).toBeInTheDocument();
  });

  it('submitting a code calls claimPairingCode with this browser token and the code', async () => {
    const claim = vi.spyOn(pairingApi, 'claimPairingCode').mockResolvedValue(undefined);
    renderOnboarding('tok-1');

    await userEvent.type(screen.getByLabelText('Pairing code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Pair daemon' }));

    expect(claim).toHaveBeenCalledWith('tok-1', '123456');
  });

  it('shows a waiting-for-first-session confirmation after a successful pair', async () => {
    vi.spyOn(pairingApi, 'claimPairingCode').mockResolvedValue(undefined);
    renderOnboarding();

    await userEvent.type(screen.getByLabelText('Pairing code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Pair daemon' }));

    expect(await screen.findByText('Daemon paired')).toBeInTheDocument();
    expect(screen.getByText('Waiting for your first session…')).toBeInTheDocument();
  });

  it('shows an inline error when claiming fails', async () => {
    vi.spyOn(pairingApi, 'claimPairingCode').mockRejectedValue(new Error('Invalid pairing code'));
    renderOnboarding();

    await userEvent.type(screen.getByLabelText('Pairing code'), '999999');
    await userEvent.click(screen.getByRole('button', { name: 'Pair daemon' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid pairing code');
  });

  it('calls onUnauthorized when claiming fails with UnauthorizedError', async () => {
    vi.spyOn(pairingApi, 'claimPairingCode').mockRejectedValue(new UnauthorizedError());
    const onUnauthorized = renderOnboarding();

    await userEvent.type(screen.getByLabelText('Pairing code'), '123456');
    await userEvent.click(screen.getByRole('button', { name: 'Pair daemon' }));

    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w @companion/web -- DaemonOnboarding.test.tsx`
Expected: FAIL — `DaemonOnboarding.tsx` does not exist yet.

- [ ] **Step 3: Implement `DaemonOnboarding`**

Create `packages/web/src/DaemonOnboarding.tsx`:

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w @companion/web -- DaemonOnboarding.test.tsx`
Expected: all 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/web/src/DaemonOnboarding.tsx packages/web/src/DaemonOnboarding.test.tsx
git commit -m "feat(web): add DaemonOnboarding component"
```

---

## Task 5: Web — wire onboarding into `SessionList`

**Files:**
- Modify: `packages/web/src/SessionList.tsx`
- Modify: `packages/web/src/App.tsx:55`
- Test: `packages/web/src/SessionList.test.tsx`

**Interfaces:**
- Consumes: `getDaemonStatus(token: string): Promise<boolean>` (Task 3), `DaemonOnboarding` (Task 4, props `{ token, onUnauthorized }`), `UnauthorizedError` (existing, `./api/sessions`).
- Produces: `SessionList` now takes props `{ token: string; onUnauthorized: () => void }` — this is a breaking change to its call site in `App.tsx`.

- [ ] **Step 1: Write the failing tests**

`packages/web/src/SessionList.test.tsx` currently renders `<SessionList />` with no props and mocks only `useSessions`. Replace the whole file with:

```tsx
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import SessionList from './SessionList';
import * as sessionsProviderModule from './SessionsProvider';
import * as devicesApi from './api/devices';
import { UnauthorizedError } from './api/sessions';
import type { SessionSummary } from './use-sessions-store';

function mockSessions(overrides: Partial<ReturnType<typeof sessionsProviderModule.useSessions>> = {}) {
  const dismissSession = vi.fn().mockResolvedValue(undefined);
  vi.spyOn(sessionsProviderModule, 'useSessions').mockReturnValue({
    sessions: [],
    loaded: true,
    connected: true,
    loadError: undefined,
    dismissSession,
    sendCommand: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    ...overrides,
  });
  return { dismissSession };
}

function renderList(token = 'tok-1', onUnauthorized = vi.fn()) {
  render(
    <MemoryRouter>
      <SessionList token={token} onUnauthorized={onUnauthorized} />
    </MemoryRouter>
  );
  return onUnauthorized;
}

describe('SessionList', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the plain empty state when there are no active sessions and a daemon is already paired', async () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(true);
    mockSessions();
    renderList();
    expect(await screen.findByText('No active sessions.')).toBeInTheDocument();
    expect(screen.queryByText('Connect your daemon')).not.toBeInTheDocument();
  });

  it('shows daemon onboarding when there are no active sessions and no daemon is paired', async () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(false);
    mockSessions();
    renderList();
    expect(await screen.findByText('Connect your daemon')).toBeInTheDocument();
    expect(screen.queryByText('No active sessions.')).not.toBeInTheDocument();
  });

  it('shows daemon onboarding if the daemon-status check itself fails', async () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockRejectedValue(new Error('HTTP 500'));
    mockSessions();
    renderList();
    expect(await screen.findByText('Connect your daemon')).toBeInTheDocument();
  });

  it('does not show onboarding or the empty-state text once real sessions exist', async () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(false);
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'running', lastEventAt: 1 }],
    });
    renderList();
    await waitFor(() => expect(screen.queryByText(/Loading/)).not.toBeInTheDocument());
    expect(screen.queryByText('Connect your daemon')).not.toBeInTheDocument();
    expect(screen.queryByText('No active sessions.')).not.toBeInTheDocument();
  });

  it('calls onUnauthorized if the daemon-status check gets a 401', async () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockRejectedValue(new UnauthorizedError());
    mockSessions();
    const onUnauthorized = renderList();
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });

  it('shows a loading state before the initial load resolves', () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(true);
    mockSessions({ loaded: false });
    renderList();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
  });

  it('sorts a waiting_permission session ahead of a more recently active one', () => {
    const sessions: SessionSummary[] = [
      { id: 'sess-a', projectPath: '/tmp/a', status: 'running', lastEventAt: 100 },
      { id: 'sess-b', projectPath: '/tmp/b', status: 'waiting_permission', lastEventAt: 1 },
    ];
    mockSessions({ sessions });
    renderList();
    const items = screen.getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('/tmp/b');
    expect(items[1]).toHaveTextContent('/tmp/a');
  });

  it('shows the attention badge for a waiting_permission session', () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'waiting_permission', lastEventAt: 1 }],
    });
    renderList();
    expect(screen.getByText('Needs attention')).toBeInTheDocument();
  });

  it('links each card to its session detail route', () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'running', lastEventAt: 1 }],
    });
    renderList();
    const cardLink = screen.getAllByRole('link').find((link) => link.getAttribute('href') === '/sessions/sess-a');
    expect(cardLink).toBeDefined();
  });

  it('links to the settings screen', () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(true);
    mockSessions();
    renderList();
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
  });

  it('shows a Dismiss button only for stopped sessions', () => {
    mockSessions({
      sessions: [
        { id: 'sess-a', projectPath: '/tmp/a', status: 'stopped', lastEventAt: 1 },
        { id: 'sess-b', projectPath: '/tmp/b', status: 'running', lastEventAt: 2 },
      ],
    });
    renderList();
    expect(screen.getAllByRole('button', { name: 'Dismiss' })).toHaveLength(1);
  });

  it('calls dismissSession with the session id', async () => {
    const { dismissSession } = mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'stopped', lastEventAt: 1 }],
    });
    renderList();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(dismissSession).toHaveBeenCalledWith('sess-a');
  });

  it('shows an inline error when dismiss fails, without removing the card', async () => {
    mockSessions({
      sessions: [{ id: 'sess-a', projectPath: '/tmp/a', status: 'stopped', lastEventAt: 1 }],
      dismissSession: vi.fn().mockRejectedValue(new Error('Session is not stopped yet')),
    });
    renderList();

    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Session is not stopped yet');
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument();
  });

  it('shows a banner when the initial list load failed', () => {
    vi.spyOn(devicesApi, 'getDaemonStatus').mockResolvedValue(true);
    mockSessions({ loadError: 'HTTP 500' });
    renderList();
    expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500');
  });
});
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `npm test -w @companion/web -- SessionList.test.tsx`
Expected: FAIL — `SessionList` does not yet accept `token`/`onUnauthorized` props or call `getDaemonStatus`.

- [ ] **Step 3: Implement the wiring**

Replace `packages/web/src/SessionList.tsx` in full with:

```tsx
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { useSessions } from './SessionsProvider';
import { sortSessions } from './sort-sessions';
import { formatRelativeTime } from './format-relative-time';
import { STATUS_LABEL } from './SessionStatusBar';
import { getDaemonStatus } from './api/devices';
import { UnauthorizedError } from './api/sessions';
import DaemonOnboarding from './DaemonOnboarding';

export interface SessionListProps {
  token: string;
  onUnauthorized: () => void;
}

export default function SessionList({ token, onUnauthorized }: SessionListProps) {
  const { sessions, loaded, connected, loadError, dismissSession } = useSessions();
  const [dismissErrors, setDismissErrors] = useState<Record<string, string>>({});
  const [daemonPaired, setDaemonPaired] = useState<boolean | undefined>(undefined);

  const sorted = sortSessions(sessions);
  const showsEmptyState = loaded && sorted.length === 0;

  useEffect(() => {
    if (!showsEmptyState) return;
    let cancelled = false;
    getDaemonStatus(token)
      .then((paired) => {
        if (!cancelled) setDaemonPaired(paired);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof UnauthorizedError) {
          onUnauthorized();
          return;
        }
        // A daemon-status check failing should never block or mislead a
        // new user — fail toward showing onboarding rather than silently
        // falling back to the unhelpful blank "No active sessions." text.
        setDaemonPaired(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showsEmptyState, token, onUnauthorized]);

  async function handleDismiss(sessionId: string) {
    setDismissErrors((prev) => {
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
    try {
      await dismissSession(sessionId);
    } catch (err) {
      setDismissErrors((prev) => ({ ...prev, [sessionId]: err instanceof Error ? err.message : String(err) }));
    }
  }

  if (!loaded) {
    return <p className="text-ink-muted p-4">Loading…</p>;
  }

  return (
    <div className="min-h-screen bg-canvas text-ink p-4 space-y-4 max-w-lg mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Sessions</h1>
        <div className="flex items-center gap-2">
          <span className={`text-xs px-2 py-1 rounded-full ${connected ? 'bg-success' : 'bg-danger'}`}>
            {connected ? 'live' : 'reconnecting…'}
          </span>
          <Link to="/settings" className="text-xs text-ink-muted underline">
            Settings
          </Link>
        </div>
      </div>

      {loadError && (
        <p role="alert" className="bg-danger-bg text-danger-text rounded-md px-4 py-3">
          Couldn't reach the relay: {loadError}
        </p>
      )}

      {showsEmptyState &&
        (daemonPaired === false ? (
          <DaemonOnboarding token={token} onUnauthorized={onUnauthorized} />
        ) : daemonPaired === true ? (
          <p className="text-ink-muted">No active sessions.</p>
        ) : null)}

      <ul className="space-y-2">
        {sorted.map((session) => (
          <li key={session.id} className="bg-panel rounded-md p-4">
            <Link to={`/sessions/${session.id}`} className="flex items-center justify-between">
              <div>
                <p className="font-medium">
                  {STATUS_LABEL[session.status]}
                  {session.status === 'waiting_permission' && (
                    <span className="ml-2 text-xs px-2 py-0.5 rounded-full bg-warning">Needs attention</span>
                  )}
                </p>
                <p className="text-sm text-ink-muted">{session.projectPath}</p>
              </div>
              <span className="text-xs text-ink-faint">{formatRelativeTime(session.lastEventAt)}</span>
            </Link>
            {session.status === 'stopped' && (
              <div className="mt-2">
                <button
                  type="button"
                  onClick={() => handleDismiss(session.id)}
                  className="text-xs px-3 py-1 rounded-md bg-border"
                >
                  Dismiss
                </button>
                {dismissErrors[session.id] && (
                  <p role="alert" className="text-xs text-danger-light mt-1">
                    {dismissErrors[session.id]}
                  </p>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
```

Note this file already reflects Task 1's semantic classes (`bg-canvas`, `text-ink-muted`, `bg-success`/`bg-danger`, `bg-danger-bg`/`text-danger-text`, `bg-panel`, `bg-warning`, `text-ink-faint`, `bg-border`, `text-danger-light`) since Task 1 ran first — no separate color-class edit needed here.

- [ ] **Step 4: Update `App.tsx`'s call site**

In `packages/web/src/App.tsx`, replace:

```tsx
          <Route path="/" element={<SessionList />} />
```

with:

```tsx
          <Route
            path="/"
            element={<SessionList token={credentials.token} onUnauthorized={handleUnauthorized} />}
          />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w @companion/web -- SessionList.test.tsx App.test.tsx`
Expected: all tests pass.

- [ ] **Step 6: Run the full web test suite**

Run: `npm test -w @companion/web`
Expected: all tests pass, no regressions.

- [ ] **Step 7: Commit**

```bash
git add packages/web/src/SessionList.tsx packages/web/src/SessionList.test.tsx packages/web/src/App.tsx
git commit -m "feat(web): show daemon onboarding on an empty, never-paired dashboard"
```

---

## Final Verification

- [ ] Run the full monorepo test suite: `npm test --workspaces --if-present` — expect all tests green across `daemon`, `protocol`, `relay`, and `web`.
- [ ] Run `npm run build --workspaces --if-present` — expect a clean build with no TypeScript errors.
- [ ] Manually verify in a browser: a brand-new account with no daemon sees the onboarding instructions on the Sessions screen; an account with a daemon already paired sees the plain "No active sessions." text; the whole app renders in the new warm palette (no cool blue/gray anywhere).
