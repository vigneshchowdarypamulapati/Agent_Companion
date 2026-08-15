# Security + Safety Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the three genuinely exploitable security holes found in the full-app review, plus the destructive-test hazard and the push-endpoint SSRF primitive.

**Architecture:** Five independent hardening changes across daemon, relay, and protocol. Each is self-contained with its own test cycle. No shared refactor — deliberately kept separable so a failure in one does not block the others.

**Tech Stack:** TypeScript, Node crypto, Express, Zod, Vitest.

**Source of truth for these findings:** `.superpowers/app-review/SUMMARY.md` and the four detailed reports beside it (`daemon-review.md`, `relay-review.md`, `crosscutting-review.md`). Each task below cites the finding it closes.

## Global Constraints

- **No behavior change to the relay's existing wire protocol.** These are auth/validation/config changes only; `SessionEvent`/`Command` schemas are untouched.
- Every new environment variable must **fail fast with an actionable message** when set to an invalid value, following the existing `COMPANION_RELAY_TRUST_PROXY` precedent in `packages/relay/src/main.ts`.
- Every new environment variable must be added to the relevant `.env.example` **and** the owning package's `README.md` in the same task that introduces it.
- Secrets (device tokens, the new daemon local token, pairing codes) must **never** be logged in full. Print only what the human must type or copy, and only to the daemon's own stdout.
- Tests must not weaken to accommodate the new auth — update them to authenticate properly instead.
- Existing test counts must not regress: the suite is 476 tests green across 4 packages at the start of this plan.

---

### Task 1: Isolate destructive tests from the production database

**Closes:** cross-cutting C3 — `npm test` runs `TRUNCATE TABLE users, devices, pairing_codes, sessions, session_events RESTART IDENTITY CASCADE` against whatever `DATABASE_URL` points at, with no guard. One stale shell env var away from wiping production data.

**Files:**
- Modify: `packages/relay/src/postgres-store.test.ts` (the `TRUNCATE` is at line 30; the `DATABASE_URL` read is at lines 12-15)
- Modify: `packages/relay/vitest.config.ts` (it currently loads `packages/relay/.env`)
- Modify: `packages/relay/.env.example`
- Modify: `packages/relay/README.md`

**Requirements:**

- Destructive tests must read **`COMPANION_TEST_DATABASE_URL`**, never `DATABASE_URL`. This is the whole point: a variable that must be deliberately set for a test database can never accidentally be a production connection string.
- If `COMPANION_TEST_DATABASE_URL` is unset, fail immediately with an actionable message naming the variable and pointing at Neon branching as the recommended way to get an isolated test database (this project uses Neon and has no Docker — see the project's storage design doc). Do **not** silently fall back to `DATABASE_URL`, and do **not** silently skip the tests: a skipped store suite would hide real regressions.
- Add a second, independent guard immediately before the `TRUNCATE`: refuse to run if `COMPANION_TEST_DATABASE_URL` is byte-identical to `DATABASE_URL` when both are set. This catches the operator who "helpfully" points both at the same database.
- Search the whole repo for any other destructive SQL (`TRUNCATE`, `DROP`, `DELETE FROM` without a `WHERE`) in test files and apply the same guard; report what you found either way.

**Verification:** with `COMPANION_TEST_DATABASE_URL` unset, `npm run test -w @companion/relay` must fail with the new message and must NOT connect to or modify any database. With it set to a valid test database, the full relay suite passes unchanged.

**Note for the implementer:** you will need the human's help to actually run the passing case, because only they can provision a Neon test branch. Implement the guard, verify the failing case yourself (that is the safety-critical half), and report clearly that the passing case needs a real `COMPANION_TEST_DATABASE_URL`. Do not invent a connection string, and do not point it at the existing database to make tests go green.

---

### Task 2: Harden the daemon's local HTTP control surface

**Closes:** daemon C1 — `packages/daemon/src/http-server.ts` + `main.ts:34`. The surface binds `127.0.0.1:4310`, starts unconditionally (including in production), has no authentication and no `Host` header validation. Any web page the user visits can DNS-rebind to loopback and `POST /sessions` to start a Claude Code session with full tool access on the user's machine. Its own README calls it "for local development and testing only", but nothing enforces that.

**Files:**
- Modify: `packages/daemon/src/http-server.ts`
- Modify: `packages/daemon/src/main.ts`
- Modify: `packages/daemon/src/http-server.test.ts`
- Modify: `packages/daemon/README.md`
- Create: `packages/daemon/src/local-auth.ts` + `packages/daemon/src/local-auth.test.ts` (token generation/persistence/comparison, kept out of the Express file so it is unit-testable on its own)

**Requirements — all three layers are required, none is sufficient alone:**

1. **Opt-in.** The HTTP surface must not start unless explicitly enabled by a new `COMPANION_DAEMON_HTTP` env var (accept `1`/`true`; anything else, including unset, means off). The relay connection is the production control channel and must keep working with the HTTP surface disabled — verify that path still works.
2. **Bearer token.** When enabled, every route requires `Authorization: Bearer <token>`. Generate 32 bytes from `node:crypto` `randomBytes`, hex-encoded. Persist it next to the existing device token (see `COMPANION_DEVICE_TOKEN_PATH` handling in `device-auth.ts` for the established pattern — reuse that file-permission approach, and set `0600` on POSIX). Print the token to the daemon's own stdout at startup so a human can use it. Compare with `crypto.timingSafeEqual` on equal-length buffers, never `===`.
3. **Host allowlist.** Reject any request whose `Host` header is not `127.0.0.1:<port>`, `[::1]:<port>`, or `localhost:<port>`. This is the layer that actually defeats DNS rebinding, because the rebinding browser sends the attacker's hostname. Return `403` with no detail.

Return `401` for a missing/invalid bearer token and `403` for a bad `Host`. Both must run as middleware **before** any route handler and before body parsing where practical, so a rejected request never reaches `SessionManager`.

**Testing:** cover each layer independently — disabled-by-default (server not listening / factory returns nothing), missing token → 401, wrong token → 401, correct token + bad `Host` → 403, correct token + good `Host` → success. Update the existing `http-server.test.ts` cases to authenticate rather than deleting or weakening them.

---

### Task 3: Pairing code entropy + persistent failed-claim lockout

**Closes:** relay C1 — `packages/relay/src/postgres-store.ts:78` generates the pairing code as `String(randomInt(0, 1_000_000)).padStart(6, '0')`: ~20 bits. A wrong guess costs the attacker nothing, and the only defence is an in-memory per-user counter that every deploy resets. A successful guess re-points a victim's daemon onto the attacker's account, at which point `inject_prompt` is arbitrary code execution on the victim's dev machine.

**Files:**
- Modify: `packages/relay/src/postgres-store.ts` (code generation), `packages/relay/src/in-memory-store.ts` (same change, keep the two stores behaviourally identical)
- Modify: `packages/relay/src/store.ts`, `packages/relay/src/store-contract-tests.ts`
- Modify: `packages/relay/src/pairing.ts`
- Modify: `packages/relay/src/db/schema.ts` + a new migration in `packages/relay/drizzle/`
- Modify: `packages/relay/src/pairing.test.ts` and any affected relay tests
- Modify: `packages/relay/README.md` if it documents the code format

**Requirements — both halves are required; entropy alone does not fix this:**

1. **Raise entropy to ≥40 bits.** Use 8 characters from Crockford base32 **excluding** `I`, `L`, `O`, `U` (ambiguity and accidental profanity), drawn with `randomBytes` and **rejection sampling** — do not use modulo, which biases the distribution. Display grouped as `XXXX-XXXX` for typeability; accept input case-insensitively and ignore hyphens/whitespace when matching, so the human can type it however they see it.
2. **Persist failed-claim attempts.** Add an attempt counter to the pairing-code row and invalidate a code after **5** failed claims. This is the half that survives deploys, and it is what actually bounds an online guessing attack. A code invalidated this way must behave exactly like an expired one to the daemon polling it (`{ status: 'expired' }`), so no new status leaks information.

Keep the existing 5-minute TTL and the existing reap-on-write sweep. Preserve the current `'not_found'` vs `'expired'` external behaviour for claims so the route's existing non-enumeration property is not weakened — verify the claim route still cannot be used to distinguish "no such code" from "wrong account".

Write the Drizzle migration by hand or via `npx drizzle-kit generate` from `packages/relay/`, and confirm which you did. Existing rows must keep working (give the new column a default).

---

### Task 4: Fail fast on an unconfigured `trust proxy` in production

**Closes:** relay C2 — `packages/relay/src/server.ts:102` does `app.set('trust proxy', trustProxyHops ?? 0)`, and `0` is also the value in `.env.example`. Behind any PaaS load balancer, `req.ip` becomes the balancer's address for every client, so both IP-keyed rate limiters collapse into a single global bucket: roughly 80 unauthenticated requests lock **every** user out of pairing and browser registration, repeatable indefinitely.

**Files:**
- Modify: `packages/relay/src/main.ts` (the existing `COMPANION_RELAY_TRUST_PROXY` parsing/fail-fast lives here)
- Modify: `packages/relay/src/server.ts`
- Modify: `packages/relay/src/server.test.ts`
- Modify: `packages/relay/.env.example`, `packages/relay/README.md`

**Requirements:**

- **Startup:** when `NODE_ENV === 'production'` and `COMPANION_RELAY_TRUST_PROXY` is unset, refuse to start. The message must explain that the value is the number of proxies in front of the relay, that `0` means "no proxy", and that guessing wrong breaks per-IP rate limiting. Forcing an explicit decision is the point — there is no safe default, because both directions are wrong in the other's environment. Outside production, keep today's default-to-`0` behaviour so local dev is unaffected.
- **Runtime:** if a request arrives carrying `X-Forwarded-For` while the configured hop count is `0`, log a single prominent warning (once per process, not per request — a per-request log is itself a DoS amplifier). This catches the operator who deployed behind a proxy and set the variable to `0`.

**Testing:** production + unset → startup throws with the explanatory message; production + set → starts; non-production + unset → starts with hop count 0; the once-only warning fires once across repeated `X-Forwarded-For` requests and not at all without the header.

---

### Task 5: Constrain push subscription endpoints (SSRF)

**Closes:** relay I6 — `packages/protocol/src/push.ts` validates the push `endpoint` only as "a well-formed `https://` URL". Any paired device can therefore store an arbitrary internal URL that the relay will then POST to on every qualifying session event: a stored, replayable, authenticated blind-SSRF primitive with built-in request amplification.

**Files:**
- Modify: `packages/protocol/src/push.ts`
- Modify: `packages/protocol/src/push.test.ts`
- Modify: `packages/relay/README.md` (document the new env var)

**Requirements:**

- Keep the existing `https:`-only rule, then additionally require the hostname to match a known browser push service. Allow these hosts and their subdomains: `fcm.googleapis.com`, `updates.push.services.mozilla.com`, `push.services.mozilla.com`, `notify.windows.com`, `web.push.apple.com`. Match on a **proper suffix boundary** — `endsWith('.fcm.googleapis.com')` or exact equality, never a bare `includes()`, which `evil-fcm.googleapis.com.attacker.test` would defeat.
- Reject any IP-literal host outright (both IPv4 and IPv6, including bracketed IPv6 form). This closes the private-range and loopback cases without needing a range table, since no legitimate push service is an IP literal.
- Provide `COMPANION_RELAY_PUSH_ENDPOINT_ALLOWLIST` (comma-separated extra hosts) so a future provider does not require a code change. Same fail-fast-if-invalid pattern as the other relay env vars.
- The rejection message must not echo the submitted URL back to the caller (it lands in logs and responses).

**Testing:** each allowed provider host accepted; a subdomain of an allowed host accepted; the suffix-boundary bypass (`evil-fcm.googleapis.com.attacker.test`) rejected; `http://` rejected; IPv4 literal, IPv6 literal, and `localhost` rejected; an internal hostname rejected; a host added via the env var accepted.

**Note:** existing tests and fixtures across the relay and web packages use example endpoints such as `https://push.example.com/...`, which this change makes invalid. Find every one of them and update to a realistic allowed host (e.g. `https://fcm.googleapis.com/fcm/send/...`). Do not add `example.com` to the allowlist to keep tests passing — that would defeat the entire task.
