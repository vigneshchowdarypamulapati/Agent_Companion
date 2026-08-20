import { z } from 'zod';

export const SessionStatus = z.enum([
  'running',
  'waiting_permission',
  'waiting_input',
  'paused',
  'stopped',
]);
export type SessionStatus = z.infer<typeof SessionStatus>;

export const SessionEvent = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('session_started'),
    sessionId: z.string(),
    projectPath: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('assistant_text'),
    sessionId: z.string(),
    text: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('tool_use'),
    sessionId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('tool_result'),
    sessionId: z.string(),
    toolName: z.string(),
    isError: z.boolean(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('permission_request'),
    sessionId: z.string(),
    requestId: z.string(),
    toolName: z.string(),
    input: z.unknown(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('permission_resolved'),
    sessionId: z.string(),
    requestId: z.string(),
    approved: z.boolean(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('turn_complete'),
    sessionId: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('error'),
    sessionId: z.string(),
    message: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('command_failed'),
    sessionId: z.string(),
    message: z.string(),
    at: z.number(),
  }),
  z.object({
    type: z.literal('stopped'),
    sessionId: z.string(),
    at: z.number(),
  }),
  z.object({
    // Emitted by the daemon's RelayClient (see packages/daemon/src/outbound-buffer.ts) when its
    // outbound buffer had to evict unacknowledged events for this session — e.g. a long relay
    // outage while the session kept streaming. It marks a gap in the history a consumer is about
    // to see, so downstream can say "some activity is missing" instead of silently presenting an
    // incomplete run as a complete one.
    type: z.literal('events_dropped'),
    sessionId: z.string(),
    at: z.number(),
  }),
  z.object({
    // Emitted once by the daemon's SessionRunner.adopt() (see session-runner.ts), immediately
    // after session_started, when a session was created by forking an existing Claude Code
    // session that was started entirely outside Companion (see docs/superpowers/specs/
    // 2026-08-20-session-adoption-design.md). `at` here is the event's own emission timestamp,
    // matching every other SessionEvent variant's convention — it is not a per-message
    // timestamp; individual historical messages carry none (see the spec for why).
    type: z.literal('adopted_history'),
    sessionId: z.string(),
    originalSessionId: z.string(),
    messages: z.array(
      z.object({
        role: z.enum(['user', 'assistant']),
        text: z.string(),
      })
    ),
    truncated: z.boolean(),
    at: z.number(),
  }),
]);
export type SessionEvent = z.infer<typeof SessionEvent>;
