import { describe, it, expect, vi, beforeEach } from 'vitest';
import webpush from 'web-push';
import { WebPushSender } from './web-push-sender.js';

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn(),
  },
}));

const subscription = { endpoint: 'https://push.example.com/abc', keys: { p256dh: 'p', auth: 'a' } };
const options = { vapidPublicKey: 'pub', vapidPrivateKey: 'priv', vapidSubject: 'mailto:you@example.com' };

describe('WebPushSender', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('configures VAPID details on construction', () => {
    new WebPushSender(options);

    expect(webpush.setVapidDetails).toHaveBeenCalledWith('mailto:you@example.com', 'pub', 'priv');
  });

  it('sends a notification and returns ok on success', async () => {
    vi.mocked(webpush.sendNotification).mockResolvedValue({} as any);
    const sender = new WebPushSender(options);

    const result = await sender.send(subscription, { title: 'Hi', body: 'There', url: '/sessions/sess-1' });

    expect(result).toBe('ok');
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      JSON.stringify({ title: 'Hi', body: 'There', url: '/sessions/sess-1' })
    );
  });

  it('returns gone on a 404 from the push service', async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue({ statusCode: 404 });
    const sender = new WebPushSender(options);

    expect(await sender.send(subscription, { title: 'Hi', body: 'There', url: '/sessions/sess-1' })).toBe('gone');
  });

  it('returns gone on a 410 from the push service', async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue({ statusCode: 410 });
    const sender = new WebPushSender(options);

    expect(await sender.send(subscription, { title: 'Hi', body: 'There', url: '/sessions/sess-1' })).toBe('gone');
  });

  it('rethrows any other error', async () => {
    vi.mocked(webpush.sendNotification).mockRejectedValue({ statusCode: 500, message: 'server error' });
    const sender = new WebPushSender(options);

    await expect(
      sender.send(subscription, { title: 'Hi', body: 'There', url: '/sessions/sess-1' })
    ).rejects.toMatchObject({ statusCode: 500 });
  });
});
