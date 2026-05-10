import { createHmac, timingSafeEqual } from 'node:crypto';

export interface VerifyWebhookOptions {
  /** Reject deliveries with `t` more than this many seconds off `now`. Default 300. */
  toleranceSeconds?: number;
  /** Override `now` for tests. */
  now?: () => number;
}

export class WebhookVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/**
 * Verify a Mergecrew outbound webhook delivery (#142).
 *
 *   verifyWebhook(
 *     rawBody,                                    // exactly the bytes the request shipped
 *     req.headers,                                // case-insensitive lookup is up to you
 *     process.env.MERGECREW_WEBHOOK_SECRET!,
 *   );
 *
 * Throws `WebhookVerificationError` on any mismatch — missing header, bad
 * timestamp, signature mismatch, or stale `t`. The thrown message is safe
 * to log; it does not include the secret or the computed signature.
 */
export function verifyWebhook(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  secret: string,
  options: VerifyWebhookOptions = {},
): void {
  const sig = pickHeader(headers, 'x-mergecrew-signature');
  if (!sig) throw new WebhookVerificationError('missing X-Mergecrew-Signature');

  // Header shape: t=<unix>,v1=<hex>
  const parts = sig.split(',').reduce<Record<string, string>>((acc, p) => {
    const [k, v] = p.split('=');
    if (k && v) acc[k.trim()] = v.trim();
    return acc;
  }, {});
  const t = Number(parts['t']);
  const v1 = parts['v1'];
  if (!Number.isFinite(t) || !v1) {
    throw new WebhookVerificationError('malformed signature header');
  }

  const tolerance = options.toleranceSeconds ?? 300;
  const nowSec = Math.floor((options.now?.() ?? Date.now()) / 1000);
  if (Math.abs(nowSec - t) > tolerance) {
    throw new WebhookVerificationError('timestamp outside tolerance');
  }

  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest('hex');
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(v1, 'hex');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new WebhookVerificationError('signature mismatch');
  }
}

function pickHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}
