export interface AgentMessage {
  type: string;
  [key: string]: unknown;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  input: unknown;
}

export interface PermissionResponse {
  approved: boolean;
  reason?: string;
}

export interface AgentQuery extends AsyncIterable<AgentMessage> {
  interrupt(): Promise<void>;
  close(): void;
}

export interface AgentQueryOptions {
  cwd: string;
  canUseTool: (request: PermissionRequest) => Promise<PermissionResponse>;
  /** Set together with `resumeSessionId` when adopting an externally-started session — forces
   * the forked session's SDK-level session ID to match Companion's own generated session ID, so
   * the two ID spaces stay unified from the fork point forward. Never set on a normal fresh
   * start. */
  sessionId?: string;
  /** The original (externally-started) session ID to fork from. When set, the real adapter
   * passes `resume` + `forkSession: true` together to the SDK — never a plain, unforked
   * `resume` — so the original transcript file is never written to again, regardless of
   * whether another process still holds it open. Absent on a normal fresh start. */
  resumeSessionId?: string;
}

export type QueryFn = (args: {
  prompt: AsyncIterable<{ type: 'user'; text: string }>;
  options: AgentQueryOptions;
}) => AgentQuery;

/** A session Claude Code knows about that this daemon did not spawn (e.g. a bare `claude` CLI
 * run, or an IDE session) — the unit `list_discoverable_sessions` returns to the phone. */
export interface DiscoveredSession {
  sessionId: string;
  summary: string;
  firstPrompt: string | undefined;
  lastModified: number;
}

export type ListSessionsFn = (options: { dir: string }) => Promise<DiscoveredSession[]>;

/** One turn of a session's prior (pre-adoption) conversation, reduced to plain text — no
 * timestamp (the SDK's transcript-read API doesn't expose one per message; see the session
 * adoption spec for why none is needed), no tool-call/tool-result detail. */
export interface HistoryMessage {
  role: 'user' | 'assistant';
  text: string;
}

export type GetSessionMessagesFn = (
  sessionId: string,
  options: { dir: string }
) => Promise<HistoryMessage[]>;
