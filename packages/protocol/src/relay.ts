import { z } from 'zod';
import { SessionEvent } from './events.js';
import { Command } from './commands.js';

export const RelayMessage = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('event'),
    sessionId: z.string(),
    seq: z.number(),
    event: SessionEvent,
  }),
  z.object({
    kind: z.literal('command'),
    sessionId: z.string(),
    command: Command,
  }),
]);
export type RelayMessage = z.infer<typeof RelayMessage>;

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
