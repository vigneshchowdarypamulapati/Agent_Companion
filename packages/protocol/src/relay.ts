import { z } from 'zod';
import { SessionEvent } from './events.js';
import { Command } from './commands.js';

/**
 * The wire protocol used to be one `RelayMessage` union shared by all four directions traffic
 * flows through this relay (daemon->relay, relay->daemon, browser->relay, relay->browser).
 * Conflating them forced every direction to squeeze into whichever fields the loosest use case
 * needed — most visibly, the daemon had to send a meaningless `seq: 0` on every outbound event
 * because only the relay (via its store) can assign the real sequence number, but the one
 * shared `event` variant required *some* value in that field.
 *
 * The four directional unions below replace it. Three variant shapes — `command_ack`,
 * `rpc_request`, `rpc_response` — are byte-for-byte identical in the two directions each
 * appears in, so they're defined once (below) and reused rather than copy-pasted. `event` and
 * `command` are deliberately NOT unified across directions: they carry different sequencing
 * fields (`deliverySeq` vs. `seq`) or an added identifier (`commandId`), and forcing them into
 * one shape is exactly the mistake this refactor undoes.
 */

/**
 * Every correlation id in the system — `commandId` and `requestId` alike — is minted by
 * `crypto.randomUUID()` (web's relay-connection.ts), and a canonical UUID is always exactly 36
 * characters. Bounding the wire schema to that length (rather than an unbounded `z.string()`)
 * matters because the relay retains one in-memory map entry per id: `pendingCommandAcks` for up
 * to 60s (hub.ts's PENDING_COMMAND_ACK_TTL_MS) and `pendingRpcRequests` for up to 30s
 * (PENDING_RPC_REQUEST_TTL_MS). With a 1 MiB maxPayload and no per-connection rate limit, an
 * unbounded id would let a single authenticated, malicious user pin arbitrarily large amounts of
 * relay memory just by sending oversized ids and never reading the replies — the id becomes the
 * map *key*, so its size is retained, not just parsed and dropped.
 *
 * This bound is shared by both id fields deliberately: `requestId` was briefly unbounded while
 * `rpc_request` was parsed-and-discarded (harmless then), and became a retained key the moment
 * RPC routing landed. Anything that becomes a relay map key belongs behind this alias.
 *
 * `.uuid()` is intentionally not used here — it would reject a legitimately-generated id if
 * `randomUUID()`'s version/variant bits ever differ from what a given zod version's `.uuid()`
 * validator accepts; a plain length bound achieves the same memory-safety goal without coupling
 * this schema to UUID format details it doesn't need to care about.
 */
const CorrelationId = z.string().max(36);

export const CommandAckMessage = z.object({
  kind: z.literal('command_ack'),
  commandId: CorrelationId,
  // 'delivered' means the daemon received and dispatched the command — not that the underlying
  // work finished. Whether/how completion is ever reported is a separate concern for later.
  status: z.enum(['delivered', 'failed']),
  message: z.string().optional(),
});
export type CommandAckMessage = z.infer<typeof CommandAckMessage>;

export const RpcRequestMessage = z.object({
  kind: z.literal('rpc_request'),
  requestId: CorrelationId,
  // method/params stay deliberately open at this envelope layer: the RPC method registry
  // belongs to whoever implements the methods, not to the transport.
  method: z.string(),
  params: z.unknown(),
});
export type RpcRequestMessage = z.infer<typeof RpcRequestMessage>;

const rpcResponseShape = z.object({
  kind: z.literal('rpc_response'),
  requestId: CorrelationId,
  result: z.unknown().optional(),
  error: z.string().optional(),
});

const RPC_RESPONSE_INVARIANT_MESSAGE = 'rpc_response must include exactly one of result or error';

function hasExactlyOneOfResultOrError(msg: { result?: unknown; error?: unknown }): boolean {
  return (msg.result !== undefined) !== (msg.error !== undefined);
}

/** Standalone, directly-usable schema for the `rpc_response` shape with its invariant enforced. */
export const RpcResponseMessage = rpcResponseShape.refine(hasExactlyOneOfResultOrError, {
  message: RPC_RESPONSE_INVARIANT_MESSAGE,
});
export type RpcResponseMessage = z.infer<typeof RpcResponseMessage>;

/**
 * `rpc_response`'s "exactly one of result/error" invariant can't be attached to the object
 * itself when it's used as a `discriminatedUnion` member: refining wraps the schema in
 * `ZodEffects`, and `discriminatedUnion` requires each member to be a plain `ZodObject` so it
 * can read the literal discriminator directly. So the plain (unrefined) `rpcResponseShape` is
 * what goes into the unions below, and this helper re-applies the same invariant with
 * `.superRefine` to each directional union that includes the variant.
 */
function withRpcResponseInvariant<T extends z.ZodTypeAny>(union: T) {
  return union.superRefine((msg, ctx) => {
    if (typeof msg !== 'object' || msg === null || (msg as { kind?: unknown }).kind !== 'rpc_response') return;
    if (!hasExactlyOneOfResultOrError(msg as { result?: unknown; error?: unknown })) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: RPC_RESPONSE_INVARIANT_MESSAGE });
    }
  });
}

export const DaemonToRelayMessage = withRpcResponseInvariant(
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('event'),
      sessionId: z.string(),
      // Daemon-assigned delivery sequence (used for buffering/redelivery — see Task 2). This is
      // NOT the store sequence: only the relay, once it durably persists the event, assigns the
      // authoritative `seq` that browsers see on RelayToBrowserMessage's `event` variant.
      deliverySeq: z.number(),
      event: SessionEvent,
    }),
    CommandAckMessage,
    rpcResponseShape,
  ])
);
export type DaemonToRelayMessage = z.infer<typeof DaemonToRelayMessage>;

export const RelayToDaemonMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('event_ack'),
    // The highest contiguous deliverySeq the relay has durably stored, so the daemon knows what
    // it can stop buffering / must retry from.
    deliverySeq: z.number(),
  }),
  z.object({
    kind: z.literal('command'),
    sessionId: z.string(),
    // Forwarded unchanged from BrowserToRelayMessage's `command` envelope, so the daemon can
    // echo it back on the command_ack it sends once dispatched (see DaemonToRelayMessage) —
    // that's how the relay eventually knows which originating browser to route the ack to.
    commandId: CorrelationId,
    command: Command,
  }),
  RpcRequestMessage,
]);
export type RelayToDaemonMessage = z.infer<typeof RelayToDaemonMessage>;

export const BrowserToRelayMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('command'),
    sessionId: z.string(),
    // Client-generated, echoed back on the command_ack the relay eventually forwards from the
    // daemon, so the browser can correlate an ack with the command it sent.
    commandId: CorrelationId,
    command: Command,
  }),
  RpcRequestMessage,
]);
export type BrowserToRelayMessage = z.infer<typeof BrowserToRelayMessage>;

export const RelayToBrowserMessage = withRpcResponseInvariant(
  z.discriminatedUnion('kind', [
    z.object({
      kind: z.literal('event'),
      sessionId: z.string(),
      // Store-assigned sequence number: authoritative and gap-free per session.
      seq: z.number(),
      event: SessionEvent,
    }),
    CommandAckMessage,
    rpcResponseShape,
  ])
);
export type RelayToBrowserMessage = z.infer<typeof RelayToBrowserMessage>;

export const RequestPairingCodeRequest = z.object({
  deviceName: z.string(),
});
export type RequestPairingCodeRequest = z.infer<typeof RequestPairingCodeRequest>;

export const ClaimPairingRequest = z.object({
  // The canonical code is 8 characters (see PAIRING_CODE_LENGTH in
  // @companion/relay's store.ts); 32 comfortably covers the displayed
  // XXXX-XXXX grouping plus incidental whitespace a human might paste in,
  // while still bounding the input the relay normalizes/matches against.
  code: z.string().max(32),
});
export type ClaimPairingRequest = z.infer<typeof ClaimPairingRequest>;

export const PollPairingRequest = z.object({
  deviceCode: z.string(),
});
export type PollPairingRequest = z.infer<typeof PollPairingRequest>;

export const RegisterBrowserRequest = z.object({
  deviceName: z.string(),
});
export type RegisterBrowserRequest = z.infer<typeof RegisterBrowserRequest>;
