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
  code: z.string(),
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
