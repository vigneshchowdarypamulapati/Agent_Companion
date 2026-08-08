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

export const RedeemPairingRequest = z.object({
  code: z.string(),
  deviceType: z.enum(['daemon', 'browser']),
  deviceName: z.string(),
});
export type RedeemPairingRequest = z.infer<typeof RedeemPairingRequest>;
