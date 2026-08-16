# Empirical findings: attaching an existing Claude Code session

Measured on the author's machine, 2026-08-15, against
`@anthropic-ai/claude-agent-sdk` as installed in this repo. These are real
command outputs, not assumptions.

## The SDK exposes everything needed for discovery

All of these exist as real runtime exports (verified with `typeof`):
`query`, `listSessions`, `getSessionInfo`, `getSessionMessages`,
`forkSession`, `deleteSession`.

`listSessions({ limit, includeProgrammatic: false })` returned the author's
real terminal sessions across all projects, newest first:

| sessionId | summary (auto-title) | cwd | lastModified | size |
|---|---|---|---|---|
| a85ad806 | "now review the entire app on opus 5 completel…" | d:\Companion | seconds ago (live) | 94.9 MB |
| 410c455d | "yes" | D:\Interactive_Digital_Envelope | 2 days | 131.8 MB |
| d515bdd5 | "/login" | D:\Companion | 8 days | 22 KB |

Key points:
- `summary` is a real human-readable title (the session's first meaningful
  prompt or `/rename` title) — good enough to show in a session picker
  without any extra work.
- `cwd` is present, which is exactly what `query({ options: { cwd } })`
  needs to adopt the session in the right directory.
- `includeProgrammatic: false` excludes SDK/daemon-entrypoint sessions —
  i.e. it excludes Companion's own sessions and shows only the terminal
  ones the user would want to adopt. This is the same filter the terminal
  `/resume` picker uses.
- `dir`-scoping works (`listSessions({ dir })` returned only this repo's
  two sessions).

## Liveness is NOT detectable

There is no "is this session currently open in a terminal" flag anywhere:
- `SDKSessionInfo` has no such field (checked the full type).
- `~/.claude/ide/*.lock` files exist but are **VS Code IDE-connection**
  locks — they carry `pid` + `workspaceFolders` + an auth token, no session
  id, and the ones on this machine are 8 days stale while sessions ran
  since. Not usable.
- `~/.claude/daemon.lock` is for Claude Code's own daemon feature, unrelated.

The only usable signal is `lastModified` recency, and it is **one-directional**:
- recently modified (seconds) → almost certainly live mid-turn → refuse adoption.
- not recently modified → tells you nothing. A session sitting idle at a
  prompt in an open terminal writes nothing.

Consequence: the design cannot detect the dangerous case automatically. It
must handle it with explicit UX, not detection.

## Backfill cost is acceptable; polling is not

`getSessionMessages('a85ad806…', { limit: 20 })` against the 94.9 MB
transcript: **1592 ms, 383 MB RSS**. The function parses the whole file and
rebuilds the parentUuid chain regardless of `limit`/`offset` (documented
behavior, confirmed by the timing).

- One-time backfill on adoption: fine (~1.6 s worst case observed).
- Repeated polling to tail a live session: **not viable** — 1.6 s and
  383 MB per poll on a large session.

This is the measurement that rules out a "watch the terminal session
read-only" mode built on `getSessionMessages` polling, and pushes v1 toward
adopt-by-resume instead.

On a small session (22 KB) the same call took 7 ms and returned 8 messages,
so the cost is genuinely proportional to transcript size.

## Resume semantics (from the SDK type docs)

- `query({ options: { resume: sessionId } })` — "Loads the conversation
  history from the specified session." Continues the **same** session id,
  appending to the same transcript file.
- `+ forkSession: true` — "resumed sessions will fork to a new session ID
  rather than continuing the previous session."
- Standalone `forkSession(sessionId)` — copies the transcript into a new
  session file with remapped UUIDs, returns the new id. Note: "Forked
  sessions start without undo history (file-history snapshots are not
  copied)."

So adopting by plain `resume` means the daemon becomes a **second writer**
to a transcript whose first writer (the terminal) may still be alive. That
is the core safety problem the design has to answer.

## Still to prototype before building

`resume` combined with a **streaming** (async-generator) prompt — which is
how `realQueryFn` already drives sessions — is not explicitly documented as
a supported combination, though nothing in the types forbids it (both are
plain `Options` fields). This is the one load-bearing assumption that
should be proven with a throwaway script before any implementation work.
