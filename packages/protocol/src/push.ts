import { z } from 'zod';

export const PushSubscriptionPayload = z.object({
  endpoint: z
    .string()
    .url()
    .refine(
      (value) => {
        try {
          return new URL(value).protocol === 'https:';
        } catch {
          return false;
        }
      },
      { message: 'endpoint must be an https:// URL' }
    ),
  keys: z.object({
    p256dh: z.string(),
    auth: z.string(),
  }),
});
export type PushSubscriptionPayload = z.infer<typeof PushSubscriptionPayload>;
