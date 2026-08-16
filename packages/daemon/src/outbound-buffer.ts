import type { SessionEvent } from '@companion/protocol';

/**
 * In-memory holding area for daemon->relay events that haven't been acknowledged yet, used by
 * RelayClient to survive relay disconnects without silently destroying events (see
 * relay-client.ts's `sendEvent`, and the daemon C2 bug this closes: a lost `session_started`
 * makes the relay reject every later event for that session, so a live session runs invisibly).
 *
 * Deliberately NOT persisted to disk. A daemon process holds its sessions (the live Claude Code
 * subprocess handles) only in memory too — a daemon restart already ends every session it was
 * running, regardless of what this buffer remembers. Persisting the buffer across restarts would
 * imply a durability guarantee ("the relay will eventually see everything, even across a daemon
 * crash") that the session layer structurally cannot honor, since there would be no live session
 * left to attach the replayed events to. So this buffer's lifetime deliberately matches the
 * sessions it describes: both live only as long as the daemon process does.
 *
 * Bounded by both entry count and total byte size, because either one alone is the wrong knob:
 * an entry-count-only cap lets a run of large tool_use/tool_result events (a session streaming a
 * big file diff or command output) blow past available memory long before the count limit is
 * reached, while a byte-only cap lets a burst of many tiny events (e.g. assistant_text tokens)
 * hold the buffer open indefinitely. The defaults below are sized for "survive a relay restart or
 * a flaky network for a few minutes of active multi-session use, without materially denting a
 * daemon's memory budget":
 *   - DEFAULT_MAX_ENTRIES = 2000: generous headroom for a relay outage spanning a burst of
 *     ordinary events (permission prompts, turn completions, short tool calls) across several
 *     concurrently-running sessions on one machine.
 *   - DEFAULT_MAX_BYTES = 8 MiB: caps worst-case memory even if some of those 2000 entries are
 *     unusually large tool_use/tool_result payloads (e.g. a few hundred KB of tool output each) —
 *     8 MiB is trivial for a background daemon process but still bounds it.
 * Whichever limit is hit first evicts the oldest entries until both are satisfied again.
 */

export interface BufferedEvent {
  readonly deliverySeq: number;
  readonly sessionId: string;
  readonly event: SessionEvent;
}

export interface OutboundBufferOptions {
  maxEntries?: number;
  maxBytes?: number;
}

export const DEFAULT_MAX_BUFFERED_ENTRIES = 2000;
export const DEFAULT_MAX_BUFFERED_BYTES = 8 * 1024 * 1024; // 8 MiB

interface StoredEntry extends BufferedEvent {
  readonly sizeBytes: number;
}

export class OutboundBuffer {
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly entries: StoredEntry[] = [];
  private totalBytes = 0;
  // Sessions that had at least one entry evicted since the last time an events_dropped marker
  // was emitted for them (see consumePendingDrop). A Set, not a count: the requirement is to
  // honestly disclose that a gap exists, not to report exactly how many events fell in it.
  private readonly sessionsWithPendingDrop = new Set<string>();

  constructor(options: OutboundBufferOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_BUFFERED_ENTRIES;
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BUFFERED_BYTES;
  }

  get size(): number {
    return this.entries.length;
  }

  /**
   * Buffers one entry, evicting the oldest entries (regardless of which session they belong to)
   * until both bounds are satisfied again. Note this can evict the entry just pushed if it alone
   * exceeds maxBytes — a single event too large to ever fit is treated the same as any other
   * overflow: it's dropped, and its session is marked for an events_dropped marker.
   */
  push(entry: BufferedEvent): void {
    const sizeBytes = byteSize(entry.event);
    this.entries.push({ ...entry, sizeBytes });
    this.totalBytes += sizeBytes;

    while (this.entries.length > this.maxEntries || this.totalBytes > this.maxBytes) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.totalBytes -= removed.sizeBytes;
      this.sessionsWithPendingDrop.add(removed.sessionId);
    }
  }

  /**
   * If `sessionId` has had entries evicted since its last marker, clears that flag and returns
   * true — the caller (RelayClient) should emit exactly one events_dropped event for it before
   * whatever it was about to send. Idempotent: a second call before the next eviction returns
   * false, so a session gets one marker per drop episode, not one per subsequent send.
   */
  consumePendingDrop(sessionId: string): boolean {
    return this.sessionsWithPendingDrop.delete(sessionId);
  }

  /** All currently-unacknowledged entries, oldest first — the full replay set after a reconnect. */
  all(): BufferedEvent[] {
    return this.entries.map(({ sizeBytes: _sizeBytes, ...rest }) => rest);
  }

  /** Drops every entry with deliverySeq <= the relay's highest contiguous stored seq. */
  acknowledge(throughDeliverySeq: number): void {
    while (this.entries.length > 0 && this.entries[0].deliverySeq <= throughDeliverySeq) {
      const removed = this.entries.shift();
      if (!removed) break;
      this.totalBytes -= removed.sizeBytes;
    }
  }
}

function byteSize(event: SessionEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}
