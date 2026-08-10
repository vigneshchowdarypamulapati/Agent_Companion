import type { PushSubscriptionPayload } from '@companion/protocol';

export interface PushPayload {
  title: string;
  body: string;
  url: string;
}

export type PushSendResult = 'ok' | 'gone';

export interface PushSender {
  send(subscription: PushSubscriptionPayload, payload: PushPayload): Promise<PushSendResult>;
}
