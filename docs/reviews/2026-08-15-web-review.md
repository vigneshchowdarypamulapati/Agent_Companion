# `packages/web` — Production-Readiness Review

Reviewed: all of `packages/web/src/**`, `vite.config.ts`, `index.html`, `src/index.css`.
Cross-referenced `packages/protocol/src/*.ts`, and (read-only, for verification of two claims)
`packages/relay/src/hub.ts` and `packages/daemon/src/session-runner.ts`.

Verification performed:
- `npm run test -w @companion/web` → **146 tests passed / 24 files**, but the command **exits 1** (see I13).
- `npm run build -w @companion/web` → succeeds; `dist/` inspected for PWA output (used to verify I4).
- WCAG contrast ratios computed numerically from the `@theme` hex values in `src/index.css`.

---

### Strengths

These are real and worth keeping:

- **The event pipeline is genuinely carefully built.** `use-sessions-store.ts` buffers live events that
  arrive before the initial REST load resolves, drains them sorted by `seq`, and — importantly — notifies
  per-session subscribers exactly *once* at arrival time rather than again at drain time
  (`use-sessions-store.ts:57-122`). I traced this specifically looking for a double-apply and there isn't
  one on that path. `SessionDetail.tsx:55-66` does its own independent buffering with a `minSeq` filter so
  the history fetch and the live stream can't duplicate each other on first load.
- **Generation counters** (`loadGenerationRef`) correctly discard the results of a superseded in-flight
  load in both `use-sessions-store.ts:124-148` and `SessionDetail.tsx:74-99`. Out-of-order responses can't
  clobber newer state.
- **Terminal auth failures are handled instead of retried forever.** `relay-connection.ts:131-147` treats
  close codes 4401/4403 as terminal and stops reconnecting — a genuinely easy thing to get wrong that
  would otherwise hammer the relay from a revoked device.
- **`openConfirmMs` (`relay-connection.ts:106-116`)** is a subtle and correct guard: backoff is only reset
  after the socket survives 3s, so a socket that opens and is *then* auth-rejected doesn't reset backoff to
  500ms and produce a tight retry loop. Backoff is exponential and capped at 10s.
- **`config.ts` derives the WS URL from the HTTP URL** so a half-configured deploy can't leave the app
  sitting on "reconnecting…" forever from a mixed-content `ws://` on an `https://` page. That's
  battle-scar-informed code.
- **Every `api/` function maps 401 → `UnauthorizedError`**, and every caller funnels it into one coherent
  app-level recovery (`App.tsx:30-34`) that clears the device token *and* signs out of Clerk — the
  reasoning in that comment (clearing only the device token would silently re-register a new device) is
  correct and non-obvious.
- **`KeyedSessionDetail` (`App.tsx:16-19`)** — remounting on `:id` change instead of letting react-router
  reuse the instance is exactly right, and already documented.
- **Tests are real, not vacuous.** `relay-connection.test.ts` stands up an actual `ws` server and tests
  reconnect, 4401, and 4403 against it. `use-sessions-store.test.ts` tests the buffering and the
  notify-exactly-once property directly. Injection seams (`createConnection`, `PushEnvironment`) are used
  instead of mutating globals.
- **The palette is mostly WCAG-clean** (ink 15.2:1 on canvas, ink-muted 6.1:1, link 6.9:1,
  danger-text on danger-bg 11.6:1). Only two values fall short (see M4).
- Error states use `role="alert"` consistently, so they *are* announced when they render.

---

## Critical (must fix — broken functionality, data loss, security)

### C1. Pause strands the session: nothing ever produces `paused`, so Resume can never be pressed

`SessionControls.tsx:10-11`, `use-sessions-store.ts:20-28`

```ts
const canPause = status === 'running' || status === 'waiting_input';
const canResume = status === 'paused';
```

I verified end-to-end that `'paused'` is unreachable as a UI status:
- `protocol/src/events.ts:12-76` — the `SessionEvent` union has **no** paused/resumed variant.
- `relay/src/hub.ts:24-32` — `STATUS_BY_EVENT_TYPE` has no entry producing `'paused'`, and
  `hub.ts:196-199` is the only place session status is written from events.
- `use-sessions-store.ts:20-28` mirrors it, also with no `'paused'`.
- `daemon/src/session-runner.ts:99` *does* set its own internal `_status = 'paused'`, but that state has
  no wire representation, so it never leaves the machine.

`'paused'` only exists as a DB enum value (`relay/src/db/schema.ts:83`) and a hand-set value in a store
contract test.

**User scenario:** You're on the train. You tap **Pause** to stop Claude burning tokens on a wrong
approach. The daemon really does interrupt the session. Your phone still says **"Running"**, Pause stays
enabled, and **Resume stays greyed out forever**. There is no way to resume the session from the phone —
you have to get back to your machine. The status bar is also actively lying about what the session is
doing, which then feeds the sort order (`sort-sessions.ts`) and the notification logic.

**Why it matters:** This is a control the UI offers, that fires, that leaves the user with no way back.
It's worse than the button not existing.

**Fix:** Add `paused`/`resumed` variants to `SessionEvent`, emit them from the daemon's command dispatcher
when pause/resume succeeds, and add `paused: 'paused'` / `resumed: 'running'` to both `STATUS_BY_EVENT_TYPE`
tables. Until that protocol change lands, the honest web-only mitigation is to remove the Pause button
rather than ship a control that strands the session. (`SessionControls.test.tsx:14` renders `status="paused"`
directly, which is why the tests don't catch this — the test asserts the component's rendering rule, not
that the rule is ever reachable.)

---

### C2. Nothing detects a dead socket, so the "live" badge lies after the phone sleeps — the primary scenario

`relay-connection.ts` (whole file), `use-relay-connection.ts:60-77`

There is **no liveness detection of any kind** anywhere in the stack. I checked for all of these and found
none:
- No application-level ping/pong or idle watchdog in `RelayConnection` — it only ever reacts to the
  browser's own `close` event (`relay-connection.ts:131`).
- No `visibilitychange`, `pageshow`, `freeze`/`resume`, or `online`/`offline` listener anywhere in
  `src/` (grepped; zero matches).
- No heartbeat on the relay side either (grepped `packages/relay/src` for ping/pong/heartbeat/isAlive —
  zero matches).

`connected` is set purely from `onOpen`/`onClose` (`use-relay-connection.ts:65-66`).

**User scenario (this is the app's stated core scenario):** You lock your phone. iOS freezes the
home-screen PWA and the underlying TCP connection dies — carrier NAT timeout, Wi-Fi→LTE handoff, or the
OS tearing it down. Twenty minutes later a push notification wakes you; you tap it. The PWA resumes from
its frozen state. The `close` event may never fire, or fires only after a long delay. Until then:

1. The pill in `SessionStatusBar`/`SessionList` says **"live"** in green.
2. `isFirstConnect`-gated gap-fill never runs (`use-sessions-store.ts:166-177`,
   `SessionDetail.tsx:109-125`), because `connected` never transitioned false→true.
3. The Activity feed is frozen at its pre-sleep contents, and the session status is whatever it was
   twenty minutes ago.
4. Worst of all: `ws.readyState` is often still reported as `OPEN` on a half-open socket, so
   `sendCommand` (`relay-connection.ts:76-79`) takes the happy path and `ws.send()` writes into a dead
   socket. Your **Approve** tap doesn't even log a drop. It just vanishes.

**Why it matters:** The whole product promise is "trust what my phone shows me and act on it." A green
"live" badge over stale data, plus taps that silently do nothing, is the single most damaging failure mode
this app can have.

**Fix (three parts, all needed):**
1. **Resume hook.** In `use-relay-connection.ts`, listen for `visibilitychange`/`pageshow`; when the
   document becomes visible, unconditionally tear down and reopen the socket (`connection.close()` then
   a fresh `connect()`), which will also drive the existing `connected` false→true gap-fill in both
   `use-sessions-store.ts` and `SessionDetail.tsx`. Also listen for `window.online`.
2. **Watchdog.** Have the relay send a `{kind:'ping'}` frame every ~25s; in `RelayConnection`, reset a
   ~40s timer on any inbound frame and, on expiry, `ws.close()` and reconnect. This is what catches a
   half-open socket while the app is *foregrounded*.
3. **Add jitter to `scheduleReconnect` (`relay-connection.ts:150-155`)** — currently a deterministic
   500ms→10s ramp. Not urgent for a single user, but free.

---

### C3. A typed prompt is destroyed, and every command silently evaporates, when the socket is down

`PromptInjectionBox.tsx:14-19`, `relay-connection.ts:75-82`, `SessionDetail.tsx:127-129`

```ts
// PromptInjectionBox.tsx:14
function handleSubmit(event: FormEvent) {
  event.preventDefault();
  if (!text.trim()) return;
  onSend({ type: 'inject_prompt', sessionId, text });
  setText('');            // <- unconditional
}
```

`onSend` → `sendCommand` → `RelayConnection.sendCommand`, which returns `void` and, when the socket
isn't `OPEN`, does this and nothing else:

```ts
// relay-connection.ts:76-79
if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
  this.onLog(`Dropping command ${command.type} …: not connected to relay`);
  return;
}
```

`onLog` is wired to `console.log` (`use-sessions-store.ts:161`). Nothing reaches the UI. Nothing is
queued. `sendCommand` has no return value the caller could check, and `connected` is never passed down to
`PromptInjectionBox`, `PermissionPrompt`, or `SessionControls` — the only thing `PromptInjectionBox`
disables on is `status === 'waiting_permission'` (`SessionDetail.tsx:186`).

**User scenario:** Patchy signal on the train; the pill flickers to "reconnecting…" and you don't notice.
You type three sentences of course-correction into the prompt box and hit **Send**. The field clears — the
universal UI signal for "sent." Nothing happens. Your text is gone; there is no draft, no error, no retry.
The same applies to **Approve** on a permission prompt (you tap it, the prompt stays on screen, and you
have no idea whether the daemon got it or the prompt just hasn't been resolved yet) and to **Stop**.

**Why it matters:** This is silent user-data loss on the app's single most important interaction, and it's
worse under exactly the conditions the app is designed for (mobile, flaky).

**Fix:**
1. Make `RelayConnection.sendCommand` return `boolean` and thread it through `useRelayConnection` and
   `useSessionsStore`.
2. In `PromptInjectionBox`, only `setText('')` when the send returned true; otherwise keep the text and
   render a `role="alert"` "Not connected — your message wasn't sent. It's still here; try again."
3. Pass `connected` down and disable/annotate Send, Approve/Deny, and Stop while disconnected, so the
   failure is visible *before* the tap.
4. Better still, buffer commands issued while disconnected and flush on reopen — but only with a visible
   "queued, will send when reconnected" state; a silent queue is its own honesty problem.

---

## Important (should fix — real UX failures, missing error handling, accessibility barriers)

### I1. Reconnect gap-fill duplicates events into the Activity feed and can regress `lastSeq`

`SessionDetail.tsx:109-125`

```ts
const gap = await getSessionEvents(token, sessionId, lastSeq);
if (gap.length === 0) return;
setEvents((prev) => [...prev, ...gap.map((g) => g.event)]);
setLastSeq(gap[gap.length - 1].seq);
```

By the time this effect runs, `connected` is already `true` — the socket is open and the relay is
delivering live events *while this HTTP fetch is in flight*. `historyLoadedRef.current` is `true`, so
`handleLiveEvent` (`SessionDetail.tsx:40-53`) appends those arrivals immediately. The gap response then
appends the same events again. There is no dedup: `events` is `SessionEvent[]` with the `seq` thrown
away at `SessionDetail.tsx:82` and `:52`, so dedup isn't even possible without a shape change.
`setLastSeq` is also assigned unconditionally rather than `Math.max`, so it can move *backwards* below a
live event already applied — which means the *next* reconnect refetches an even wider window and
duplicates more.

**User scenario:** You step out of an elevator while Claude is mid-turn. The socket reconnects. The
Activity feed now reads "Used Edit / Used Edit / Used Bash / Used Bash / Turn complete / Turn complete."
You cannot tell whether Claude edited the file once or twice. `findPendingPermissionRequest` and
`findLastAssistantText` still behave, and `ModifiedFilesPanel` dedups via a `Set`, so this is display
corruption rather than a functional break — but it's corruption of the thing you're reading to decide
what to do.

**Fix:** Store `{ seq, event }[]` in `events`, merge by `seq` into a Map (last-write-wins), keep it
sorted, and use `setLastSeq((prev) => Math.max(prev, …))`. That also fixes the `key={index}` issue (M2).
There is no test covering this race; add one that emits a live event while the gap fetch promise is
pending.

---

### I2. Nothing wraps: long paths and long assistant text force horizontal page scroll on a phone

I grepped the entire `src/` tree for `break-words`, `break-all`, `truncate`, `min-w-0`, `whitespace-pre`,
`line-clamp`, and `overflow-hidden`. **Zero matches** — the only overflow handling in the whole app is one
`overflow-x-auto` on `PermissionPrompt.tsx:19`.

Affected:
- `ActivityFeed.tsx:14` — `<li className="text-sm bg-panel rounded-md px-3 py-2">` renders raw
  `assistant_text`. Default `overflow-wrap: normal` does not break inside an unbroken token.
- `ModifiedFilesPanel.tsx:16` — `font-mono` file paths. This is the *worst* case: Windows paths
  (`D:\Companion\packages\web\src\use-sessions-store.ts`) have no break opportunities at all, and browsers
  do not reliably break POSIX paths at `/` either.
- `SessionDetail.tsx:180` — the "Claude is waiting for your reply" callout.
- `SessionStatusBar.tsx:19-23` and `SessionList.tsx:96` — `flex items-center justify-between` with an
  unconstrained text child. Flex items default to `min-width: auto`, so a long `projectPath` refuses to
  shrink and pushes the width past the viewport.

No `overflow-x: hidden` on `html`/`body` either, so the overflow escapes to the document.

**User scenario:** On a 375px-wide iPhone SE/13 mini, opening a session whose `projectPath` is
`/Users/vignesh/dev/work/companion-monorepo/packages/web` makes the whole page horizontally scrollable.
Every card is now wider than the screen, the "live" pill is pushed off the right edge, and you have to
pan sideways to read a modified-file entry.

**Fix:** `break-words` (`overflow-wrap: anywhere`) on the activity `<li>`, the callout `<p>`, and the
file-path `<li>`; add `min-w-0` to the text-side flex children in `SessionStatusBar` and `SessionList`
plus `truncate` or `break-all` on the path; add `overflow-x: hidden` to `body` as a backstop.

---

### I3. Claude's multi-line replies are collapsed into a single run-on paragraph

`ActivityFeed.tsx:31-32`, `SessionDetail.tsx:180`

`assistant_text` is rendered as a bare text node with no `whitespace-pre-wrap` and no markdown handling.
HTML collapses all newlines and runs of whitespace.

**User scenario:** Claude replies with a numbered plan or a bulleted summary — the exact content you're
checking your phone to read. It arrives as one unbroken wall of prose with the list markers embedded
inline: "Here's the plan: 1. Refactor the store 2. Add the ping 3. Ship it Which should I start with?"
On a 375px screen that's a solid paragraph you have to parse manually before you can reply.

**Fix:** Add `whitespace-pre-wrap break-words` to both. Real markdown rendering would be better but is a
bigger change; `pre-wrap` alone recovers most of the readability for free.

---

### I4. The service worker never updates — an installed PWA stays on the old build indefinitely

`vite.config.ts:16-19`, `src/sw.ts`

`registerType: 'autoUpdate'` is set, but with `strategies: 'injectManifest'` vite-plugin-pwa does not add
the lifecycle calls for you — you have to write them. `src/sw.ts` calls neither `self.skipWaiting()` nor
`clientsClaim()`. I verified this against the actual build output:

```
$ grep -o "skipWaiting\|clientsClaim\|clients.claim" dist/sw.js
(no output)

$ cat dist/registerSW.js
if('serviceWorker' in navigator) {window.addEventListener('load', () => {
  navigator.serviceWorker.register('/sw.js', { scope: '/' })})}
```

That's the plain registration — no update polling, no `updateSW`, no skip-waiting handshake. A new SW
therefore parks in `waiting` until **every** client of the origin is closed.

**User scenario:** You ship a fix for one of the bugs in this report. Your phone's home-screen PWA is
never fully killed (iOS keeps it in the app switcher for days). It keeps serving the *precached* old
bundle — indefinitely. You test the fix on desktop, it works, and you spend an afternoon confused about
why the phone still misbehaves. For an app the author is actively developing against, this is expensive.

**Fix:** Add to `src/sw.ts`:
```ts
import { clientsClaim } from 'workbox-core';
self.skipWaiting();
clientsClaim();
```
and consider `self.addEventListener('message', e => e.data?.type === 'SKIP_WAITING' && self.skipWaiting())`
plus a periodic `registration.update()` if you'd rather prompt than force-reload.

---

### I5. `viewport-fit=cover` is set but nothing handles the safe area, the status bar, or mobile `vh`

`index.html:5`, `src/index.css`, all screen components

`index.html` opts into edge-to-edge with `viewport-fit=cover`, which extends content *under* the notch and
the iOS home indicator — and then nothing compensates. I grepped for `safe-area`, `env(safe`,
`theme-color`, `apple-mobile-web-app`, `dvh`, `100dvh`: **zero matches**. The built `dist/index.html`
confirms vite-plugin-pwa injects only the manifest link, no `theme-color` meta.

Three separate consequences:
1. **No `env(safe-area-inset-*)` padding.** Every screen is `p-4` (16px). On an iPhone 14/15 in the
   home-screen PWA, the top 16px of the "Sessions" header sits under the status bar clock, and the
   bottom-most element (the Activity feed's last item) sits under the home indicator bar.
2. **No `<meta name="theme-color">` and no `apple-mobile-web-app-status-bar-style`.** The manifest's
   `theme_color: '#201a16'` covers Android's task switcher, but Safari does not read the manifest for the
   status-bar tint. Launched from the home screen on iOS you get a default-styled bar over a very dark
   app.
3. **`min-h-screen` = `100vh`**, which on mobile Safari/Chrome means the *expanded* viewport including the
   URL bar. The bottom of the page is clipped until you scroll.

**Fix:** Add to `index.html`: `<meta name="theme-color" content="#201a16">` and
`<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">`. In `index.css`, add a
utility (or `body` rule) applying `padding-top: env(safe-area-inset-top)` /
`padding-bottom: env(safe-area-inset-bottom)`. Swap `min-h-screen` for `min-h-dvh`.

---

### I6. Touch targets are under 44px — including Approve/Deny, the highest-stakes tap in the app

Computed from the Tailwind classes actually used (text-sm = 20px line-height, text-xs = 16px):

| Control | Classes | Height | Where |
|---|---|---|---|
| **Approve / Deny** | `text-sm px-3 py-2` | **36px**, 8px apart | `PermissionPrompt.tsx:21-34` |
| Pause / Resume / **Stop** | `text-sm px-3 py-2` | **36px** | `SessionControls.tsx:16-39` |
| Prompt input / Send | `px-3 py-2` / `px-4 py-2` | **40px** | `PromptInjectionBox.tsx:29,34` |
| Dismiss | `text-xs px-3 py-1` | **24px** | `SessionList.tsx:113-119` |
| "Settings" link | `text-xs underline`, no padding | **~16px** | `SessionList.tsx:74` |
| "← Back to sessions" | `text-sm underline`, no padding | **~20px** | `SessionDetail.tsx:153` |

Apple's HIG and WCAG 2.2 SC 2.5.8 both put the floor at 44×44 CSS px.

**User scenario:** A lock-screen push wakes you at 11pm: "Claude wants to use Bash." You tap in, half
awake, one-handed, and you're presented with two 36px-tall buttons 8px apart where the *left* one approves
a shell command and the *right* one denies it. Mis-taps on that pair are consequential and irreversible
from the phone. Separately, the "Settings" link is a 16px-tall text target in the top-right corner — the
hardest region of a phone screen to reach and the smallest thing on it.

**Fix:** `min-h-11` (44px) on all buttons; `py-3` on Approve/Deny and increase the gap to `gap-3`;
give the Settings and back links `p-2 -m-2` so the hit area grows without changing layout. Consider a
confirm step or a swipe gesture for Approve specifically.

---

### I7. The push handler is not robust to a malformed payload

`sw.ts:14-30`

```ts
if (!event.data) return;
let payload: { title: string; body: string; url: string };
try { payload = event.data.json(); } catch { return; }
event.waitUntil(self.registration.showNotification(payload.title, {…}));
```

Two problems:
- The `try/catch` only guards *parse* failure. Any valid JSON that isn't the expected shape sails through
  unvalidated — the type annotation is a compile-time fiction over `any`. A payload of `{}` or `"hi"`
  produces `showNotification(undefined)`, which the spec coerces to the literal string **"undefined"** as
  the notification title, with an undefined `tag` and `data.url` (so `notificationclick` falls back to
  `/`). The user gets a lock-screen notification titled "undefined" that opens the wrong screen.
- Both early `return`s show **no notification at all**. Under the `userVisibleOnly: true` subscription this
  app uses (`push-notifications.ts:60`), Chrome responds to a push that shows no notification by
  displaying its own generic *"This site has been updated in the background"* notification — and after
  repeated offences it revokes the push permission entirely, silently killing the feature.

**Fix:** Validate with the protocol's Zod (or a hand-rolled shape check) and fall back rather than return:
on any invalid/missing payload, still call `showNotification('Claude Companion', { body: 'Your session
needs attention', data: { url: '/' } })`.

---

### I8. `notificationclick` opens a second window instead of focusing the one that's already open

`sw.ts:32-49`

```ts
const clients = await self.clients.matchAll({ type: 'window' });
const client = clients.find((c): c is WindowClient => 'focus' in c);
```

`matchAll` defaults to `includeUncontrolled: false`, so it only returns clients **this** service worker
controls. A window loaded before the current SW took control — which is the normal state after any SW
update, and (given I4, where the SW *never* updates cleanly) a state this app will hit — is invisible to
this query. `client` comes back undefined and the handler falls through to `openWindow`.

Secondarily, `clients.find(…)` picks the *first* window client with no regard for which session it's
showing, and the `client.navigate(url)` return value is discarded — `focus()` is then called on the
pre-navigation handle rather than the one `navigate()` resolves to.

**User scenario:** Your phone already has the Companion PWA open on session A. A push arrives for session
B. You tap it and get a *second* Companion window/tab rather than the existing one navigating — losing any
text you had typed and leaving two copies of the app running with two WebSockets.

**Fix:**
```ts
const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
const client = clients.find((c) => 'focus' in c) as WindowClient | undefined;
if (client) {
  const target = (await client.navigate(url)) ?? client;
  await target.focus();
  return;
}
```
Better still: `postMessage` the target URL to the focused client and have the app's router handle it
client-side, so tapping a notification doesn't discard the running app's state and re-boot the bundle.

---

### I9. Nothing that updates asynchronously is announced — no `aria-live` anywhere

I grepped for `aria-live` and `role="status"` across `src/`: exactly **one** hit
(`DaemonOnboarding.tsx:36`). Error states do use `role="alert"` (which carries implicit `aria-live`), so
errors are covered — but nothing else is.

Not announced:
- A `permission_request` arriving and `PermissionPrompt` mounting mid-screen
  (`SessionDetail.tsx:165-173`). This is the single most important async arrival in the product.
- New items appearing in `ActivityFeed` (`ActivityFeed.tsx:12-18`).
- The connection pill flipping between "live" and "reconnecting…"
  (`SessionStatusBar.tsx:24-26`, `SessionList.tsx:71-73`).
- The session status changing from Running → Waiting for you.

**User scenario:** A VoiceOver user has the session detail screen open. Claude finishes its turn and asks
a question; then a permission request appears. Both events are completely silent — the user has to
manually re-swipe through the page to discover anything changed.

**Fix:** Wrap the permission prompt region in `aria-live="assertive"`, the activity list in
`aria-live="polite" aria-relevant="additions"`, and the connection pill in `role="status"`. On the
connection pill, also add text-independent semantics — right now the only difference in the DOM between
the two states is the label text and the background colour, which is fine for the label, but the
`bg-success`/`bg-danger` distinction alone carries no programmatic meaning.

---

### I10. On iPhone, "Enable notifications" will likely be rejected: the permission prompt is called after an `await`

`push-notifications.ts:49-56`

```ts
export async function enablePush(token, env = defaultEnvironment) {
  const publicKey = await getVapidPublicKey();     // <- network round-trip
  if (!publicKey) throw new Error(…);
  const permission = await env.requestPermission(); // <- gesture already consumed
```

`handleEnablePush` (`SettingsScreen.tsx:116-133`) is a click handler, so the call *starts* with user
activation — but WebKit consumes transient activation across an awaited network fetch, and Safari requires
`Notification.requestPermission()` to be called from a user gesture. On iOS this is very likely to reject
outright (Chrome/Firefox are more permissive, which is why it works on desktop).

**User scenario:** On your iPhone, in the home-screen PWA, you go to Settings and tap "Enable
notifications." Nothing appears, or the promise rejects, and you get "Notification permission was not
granted" — with no way to make progress. Push is the feature that makes the lock-screen scenario work at
all, so this is potentially the difference between the product working and not working on the author's
primary device.

**Note on confidence:** I have not run this on a physical iPhone; the reasoning is from WebKit's
user-activation rules plus the code order, which I verified. Reordering costs nothing and removes the risk.

**Fix:** Call `env.requestPermission()` **first**, synchronously in the handler's first tick, before any
`await`. Fetch the VAPID key afterwards (or pre-fetch it in the effect at `SettingsScreen.tsx:57-75`,
where it's already fetched once, and pass it in).

---

### I11. `command_failed` — the only feedback that a command didn't work — is buried at the bottom of the page

`use-sessions-store.ts:14-28` (deliberately omitted from the status map),
`ActivityFeed.tsx:45-46` (the only place it's rendered)

The omission from `STATUS_BY_EVENT_TYPE` is well-reasoned and documented — a recoverable command failure
shouldn't change the session's status. But the consequence is that when the daemon reports a command
failed, the *only* place it surfaces is as one more `<li>` in the Activity feed, which on
`SessionDetail.tsx:196-199` sits **below** the modified-files panel, below the prompt box, below the
controls — i.e. off-screen on a phone.

**User scenario:** You send a follow-up prompt. The daemon can't inject it (session busy, SDK error), and
emits `command_failed`. Your input cleared, the status bar still says "Running," and the only evidence is
a grey line item you'd have to scroll past two panels to find. You sit there waiting for a reply that will
never come.

**Fix:** Track the most recent `command_failed` in `SessionDetail` and render it as a dismissible
`role="alert"` banner near the prompt box (where the failed action was taken), in addition to the feed
entry. This is also the natural home for the C3 "wasn't sent" message.

---

### I12. No error boundary — one render throw is a permanent white screen on the phone

There is no `componentDidCatch`/`ErrorBoundary` anywhere in `src/`. React 19 unmounts the whole tree on an
uncaught render error.

Reachable paths: `useSessions()` throws by design outside a provider (`SessionsProvider.tsx:20`);
`main.tsx:14` throws outright when `VITE_CLERK_PUBLISHABLE_KEY` is missing; `describeEvent`
(`ActivityFeed.tsx:27`) returns `undefined` for an event variant added to the protocol but not to the
switch — which is a type error at build time, but the events crossing the wire are only validated against
the *bundled* copy of the protocol, and a phone running a stale SW-cached bundle (see I4) against an
upgraded relay is exactly the mismatch case.

**User scenario:** Anything unexpected renders a blank dark screen with no message, no retry, and — since
the app is a home-screen PWA — no visible way to hard-reload. The user's only recourse is to delete and
re-add the app.

**Fix:** Wrap `<App />` in an error boundary that renders "Something went wrong" plus a reload button, and
replace the `main.tsx` throws with the same rendered state.

---

### I13. `npm run test -w @companion/web` exits 1 even though all 146 tests pass

```
Test Files  24 passed (24)
     Tests  146 passed (146)
    Errors  3 errors
  Duration  247.73s (… setup 134.70s, environment 292.95s)

Error: [vitest-pool]: Failed to start forks worker for test files … SessionList.test.tsx
Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond
```

Every test passed; the run failed on worker-startup timeouts. Note `setup 134.70s` and
`environment 292.95s` for 15s of actual test execution — jsdom environment construction is dominating,
and the pool is timing out under it.

**Why it matters:** A test command that's red when everything passes trains you (and any CI) to ignore
red. It also means the suite can't gate anything.

**Fix:** Set `test.pool: 'threads'` (much cheaper per-worker than `forks` for jsdom), raise
`test.teardownTimeout`/pool timeouts, and/or cap `poolOptions.threads.maxThreads`. Also consider
`environmentMatchGlobs` so the pure-logic tests (`sort-sessions`, `format-relative-time`,
`modified-files`, `config`, `storage`) run in `node` instead of paying for a jsdom instance each.

---

### I14. Offline is reported as a relay failure, and a briefly-unreachable relay silently deletes the Notifications section

Two related honesty problems:

**(a)** The SW precaches the shell and `NavigationRoute` serves it (`sw.ts:7,12`), so with no network the
app *boots* — and then every `fetch` in `api/` throws `TypeError: Failed to fetch`, which
`use-sessions-store.ts:140` renders as **"Couldn't reach the relay: Failed to fetch"** with a red
"reconnecting…" pill. That blames the server for the user's aeroplane mode, and "Failed to fetch" is not
language a user can act on. There's no `navigator.onLine` check anywhere (grepped; zero matches).

**(b)** `SettingsScreen.tsx:71`:
```ts
void loadPushState().catch(() => {});
```
The comment says an unreachable relay "legitimately means no notifications section" — but it doesn't. It
conflates *"this server has no VAPID key configured"* (a permanent, correct reason to hide the section)
with *"the network hiccuped for 200ms"* (transient). In the latter case the entire **Notifications**
section vanishes from Settings with no explanation and no retry short of a full reload.

**Fix:** (a) Branch on `navigator.onLine` (plus `online`/`offline` listeners) and render an explicit
"You're offline — showing the last data received at HH:MM" state instead of a relay error. (b) Distinguish
a 404 from `getVapidPublicKey` (hide the section) from a thrown network error (show the section with a
"Couldn't check notification settings — Retry" state).

---

### I15. Device token lives in `localStorage` and is sent in the WebSocket URL query string

`storage.ts:6,28-30`, `relay-connection.ts:84-87`

```ts
const target = `${base}${separator}token=${encodeURIComponent(this.token)}`;
```

**Blast radius.** The device token is long-lived and grants full session control — including
`inject_prompt`, which is arbitrary instruction execution inside a Claude Code session on the author's dev
machine, and `respond_to_permission`, which can approve a `Bash` tool call. That is effectively remote code
execution on the developer's workstation. `localStorage` is readable by any script running on the origin.

**In the app's favour, and I verified this:** there is no `dangerouslySetInnerHTML` anywhere, all
user/assistant content renders as React text nodes, and the app never `eval`s remote content. So there's no
XSS vector *in this codebase* today. The realistic threat is a compromised dependency (the app loads
Clerk's SDK, and pulls 255 modules into the bundle) or a future feature that renders markdown/HTML — at
which point a single injected script exfiltrates the token and keeps working forever.

**The query-string part is a separate, concrete issue:** tokens in URLs get written to reverse-proxy access
logs, CDN logs, and any WS-aware middlebox, in a way `Authorization` headers do not. This is a documented
anti-pattern (OWASP ASVS 3.5) and is worth fixing regardless of the storage question.

**Fix, in order of value:**
1. Move the WS token off the URL: use the `Sec-WebSocket-Protocol` subprotocol header to carry it, or
   have the browser open the socket unauthenticated and send an `{kind:'auth', token}` frame as the first
   message (the relay already has to handle a post-upgrade rejection — see the 4401 handling — so the
   plumbing exists).
2. Add a Content-Security-Policy (`default-src 'self'`, explicit allowances for Clerk's domains and the
   relay origin, `object-src 'none'`, `base-uri 'none'`). There is currently no CSP meta tag in
   `index.html` and no header config in the repo.
3. Longer term, prefer a short-lived token refreshed from the Clerk session over a long-lived one at rest.
   If the device token must persist, an `httpOnly` cookie from the relay origin would remove the XSS
   exfiltration path entirely — at the cost of CSRF handling.

---

## Minor (nice to have)

**M1. Relative timestamps freeze.** `formatRelativeTime` (`format-relative-time.ts`) is called during
render at `SessionList.tsx:109` with no interval driving re-renders. A session that goes quiet shows
"just now" forever until the next event for *any* session re-renders the list. Fix: a 30s
`setInterval` tick in `SessionList`, or a `<time dateTime>` element with a small hook.

**M2. `key={index}` in `ActivityFeed.tsx:13`.** Indices shift when `session_started` resets the array
(`SessionDetail.tsx:46-49`), and it defeats reconciliation on every append. Fixed for free by the `seq`
refactor in I1.

**M3. Feed layout fights the primary task.** The Activity feed is the *last* thing on
`SessionDetail` (`:196-199`), below the prompt box (`:184`). It's append-only with no auto-scroll and no
"new activity ↓" affordance. On a phone this means: to read what just happened you scroll down; to reply
you scroll back up. Consider putting the feed above the input, pinning the input to the bottom (with
`env(safe-area-inset-bottom)` and `dvh`, per I5), and auto-scrolling when already near the bottom.

**M4. Two palette values fail WCAG AA.** Computed from `index.css`:
- `--color-ink-faint: #8a7666` → **3.98:1 on canvas, 3.48:1 on panel** (needs 4.5:1). Used at 12px for
  every session's relative timestamp (`SessionList.tsx:109`) and for the "No activity yet." /
  "No files modified yet." empty states (`ActivityFeed.tsx:9`, `ModifiedFilesPanel.tsx:11`). Darken the
  background or lift `ink-faint` to roughly `#9c8878`.
- `ink` on `--color-warning: #8a6a2c` → **4.44:1** for the 12px "Needs attention" pill
  (`SessionList.tsx:101`). Marginal; darken warning to ~`#7d5f27` to clear 4.5.

Everything else passes comfortably, including both connection pills (`ink` on success 5.35, on danger 5.87).

**M5. `tool_use` shows only the tool name.** `ActivityFeed.tsx:33-34` renders "Used Edit" with no file,
no command, no argument — the `input` field is discarded. On a phone, "Used Bash / Used Bash / Used Edit"
tells you almost nothing about what Claude actually did. `permission_request` gets the same treatment in
the feed (`:38`), even though the full input *is* available and is shown in `PermissionPrompt`.

**M6. Reviewing a permission means horizontally scrolling a 12px box.** `PermissionPrompt.tsx:19` uses
`<pre … overflow-x-auto>`, which correctly contains the overflow — but a `Bash` command's `command` field
is one long line, so on a 375px screen you must side-scroll a tiny monospace box to read the command you
are about to approve. Given this is the app's most safety-critical read, prefer
`whitespace-pre-wrap break-all` with a `max-h-48 overflow-y-auto`, and special-case the common shapes
(`command` for Bash, `file_path` for edits) into a readable summary above the raw JSON.

**M7. `events` grows unbounded.** `SessionDetail` accumulates every event of a session and
`ActivityFeed` renders all of them. A multi-hour session produces thousands of DOM nodes on a phone, with
`deriveModifiedFiles` and `findPendingPermissionRequest` re-scanning the whole array on every render (both
are called unmemoised at `SessionDetail.tsx:148,193`). Cap the rendered window (last ~200, "load earlier")
and memoise the two derivations.

**M8. `enablePush` doesn't handle an existing subscription.** `push-notifications.ts:59` calls
`pushManager.subscribe` unconditionally; if a subscription already exists with a *different*
`applicationServerKey` (VAPID key rotated on the relay) it throws `InvalidStateError`, surfaced to the
user as raw DOMException text. Call `getSubscription()` first and `unsubscribe()` if the key differs.

**M9. `BrowserRegistrationGate` may register the device more than once.**
`BrowserRegistrationGate.tsx:40` depends on Clerk's `getToken`, whose identity is not contractually
stable across session refreshes; each change re-runs the effect and calls `registerBrowserDevice` again,
minting a second device row and a second token (last one wins in `localStorage`, the first is orphaned).
React StrictMode also double-invokes this in dev. The window is small (the gate unmounts on success), but
a `useRef` "already started" guard would close it.

**M10. `guessDeviceName` sends 60 raw UA characters.** `devices.ts:64` — Settings then displays
`Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKi` as the device name
(`SettingsScreen.tsx:169`). Parse to something like "iPhone · Safari".

**M11. `notificationclick` path comparison is brittle.** `sw.ts:40` compares
`new URL(client.url).pathname !== url`; if the push payload's `url` ever gains a query string or hash the
comparison never matches and it re-navigates unnecessarily. Compare
`new URL(url, self.location.origin).href` against `client.url`.

**M12. `NavigationRoute` has no denylist.** `sw.ts:12` serves the precached shell for *every* same-origin
navigation. Harmless today (the relay is a separate origin), but any future same-origin path — an OAuth
callback, a health endpoint, a static doc — will silently be swallowed by the SPA shell. Add a
`{ denylist: [/^\/api\//, ...] }`.

**M13. Prompt input ergonomics.** `PromptInjectionBox.tsx:23-30` is a single-line `<input>` for what is
often a multi-sentence instruction, with no `enterKeyHint="send"`, no `autoCapitalize="sentences"`, no
`autoCorrect`, and no draft persistence. A `<textarea>` with `rows={1}` + auto-grow and
`enterKeyHint="send"` is a small change with a large payoff on mobile.

**M14. `sw.ts` has zero tests.** Push and `notificationclick` are the headline mobile features and the
only completely untested module in the package. Both handlers are pure enough to test by importing the
module against a fake `self` with a registered-listener map — worth it, especially given I7 and I8.

---

### Assessment — production-ready for phone-first use?

**Not yet, but the distance is short and the foundations are good.** The state layer is the part I
expected to find bugs in and it largely holds up: the buffer-then-drain sequencing, the notify-once
subscriber fan-out, and the generation-counter guards are all correct, deliberate, and documented, and the
4401/4403 terminal handling plus the `openConfirmMs` backoff guard show someone who has actually thought
about a flapping connection. What isn't ready is everything that sits between that correct core and a
person holding a phone. Three things block shipping. **Pause is a trap** (C1): the button fires, the daemon
really pauses, and no event exists in the protocol to tell the phone about it, so Resume is permanently
greyed out and the session is stranded until you walk back to your machine. **Nothing detects a dead
socket** (C2): after the phone sleeps — the app's *defining* scenario — the badge says "live" over stale
data and taps write into a half-open socket, which turns the product's core promise ("trust this screen and
act on it") into a coin flip. And **commands are silently swallowed** (C3): the prompt box clears your text
on send whether or not the send happened, so the one interaction the whole app exists to enable loses user
data on exactly the flaky connections it's designed for. Behind those, the mobile layer is essentially
unfinished — `viewport-fit=cover` is opted into but no safe-area padding, `theme-color`, or `dvh` follows
it (I5); nothing in the entire package wraps text, so a normal project path forces the whole page to scroll
sideways on a 375px screen (I2); Claude's multi-line replies collapse into a single blob (I3); Approve and
Deny are 36px targets 8px apart for a decision you can't undo (I6); and no asynchronously-arriving content
is announced to assistive tech (I9). The service worker also never updates (I4), which means every fix
above may not reach the author's own phone until they delete and reinstall the app — I'd fix that one
*first*, purely so the rest can be verified. Fix C1–C3 and I2–I6, and this becomes a genuinely good
phone-first tool; the tests, the error plumbing, and the palette are already at that level.
