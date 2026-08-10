import webpush from 'web-push';
import type { PushSubscriptionPayload } from '@companion/protocol';
import type { PushPayload, PushSendResult, PushSender } from './push-sender.js';

export interface WebPushSenderOptions {
  vapidPublicKey: string;
  vapidPrivateKey: string;
  vapidSubject: string;
}

export class WebPushSender implements PushSender {
  constructor(options: WebPushSenderOptions) {
    webpush.setVapidDetails(options.vapidSubject, options.vapidPublicKey, options.vapidPrivateKey);
  }

  async send(subscription: PushSubscriptionPayload, payload: PushPayload): Promise<PushSendResult> {
    try {
      await webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: subscription.keys },
        JSON.stringify(payload)
      );
      return 'ok';
    } catch (err) {
      const statusCode = (err as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        return 'gone';
      }
      throw err;
    }
  }
}
