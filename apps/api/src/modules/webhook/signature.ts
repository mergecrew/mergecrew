import { ForbiddenException } from '@nestjs/common';
import crypto from 'node:crypto';

/**
 * Shared inbound-webhook verification helpers. Every provider route
 * fails closed: an unset / empty secret rejects the request (an empty
 * HMAC key is publicly computable), and every comparison is
 * constant-time.
 */

/** Returns the configured secret or throws 403 when it is unset/blank. */
export function requireWebhookSecret(envName: string, provider: string): string {
  const secret = process.env[envName];
  if (!secret || !secret.trim()) {
    throw new ForbiddenException(`${provider} webhook secret not configured`);
  }
  return secret;
}

/** Throws 403 unless the body arrived unparsed (raw-body middleware). */
export function requireRawBody(body: unknown): Buffer {
  if (!Buffer.isBuffer(body)) throw new ForbiddenException('expected raw body');
  return body;
}

export function hmacSha256Hex(secret: string, data: Buffer | string): string {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

/** Constant-time string equality (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

/** GitHub: `X-Hub-Signature-256: sha256=<hex hmac(body)>`. */
export function verifyGitHubSignature(
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  secret: string,
): boolean {
  if (!secret) return false;
  const sig = header(headers, 'x-hub-signature-256');
  if (!sig || !sig.startsWith('sha256=')) return false;
  return safeEqual(sig.slice('sha256='.length).toLowerCase(), hmacSha256Hex(secret, body));
}

/** Sentry: `sentry-hook-signature: <hex hmac(body)>`. */
export function verifySentrySignature(
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  secret: string,
): boolean {
  if (!secret) return false;
  const sig = header(headers, 'sentry-hook-signature');
  if (!sig) return false;
  return safeEqual(sig.toLowerCase(), hmacSha256Hex(secret, body));
}

export const LINEAR_TIMESTAMP_TOLERANCE_MS = 60 * 1000;

/**
 * Linear: `linear-signature: <hex hmac(body)>`, plus the payload's
 * `webhookTimestamp` (ms) must be within a minute of now (replay guard).
 * Returns the parsed payload on success, `null` otherwise.
 */
export function verifyLinearWebhook(
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  secret: string,
  now = Date.now(),
): Record<string, unknown> | null {
  if (!secret) return null;
  const sig = header(headers, 'linear-signature');
  if (!sig) return null;
  if (!safeEqual(sig.toLowerCase(), hmacSha256Hex(secret, body))) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const ts = (parsed as { webhookTimestamp?: unknown }).webhookTimestamp;
  if (typeof ts !== 'number' || !Number.isFinite(ts)) return null;
  if (Math.abs(now - ts) > LINEAR_TIMESTAMP_TOLERANCE_MS) return null;
  return parsed as Record<string, unknown>;
}

export const SLACK_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/** Slack: `x-slack-signature: v0=<hex hmac("v0:<ts>:<body>")>` + 5-min timestamp window. */
export function verifySlackSignature(
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  secret: string,
  now = Date.now(),
): boolean {
  if (!secret) return false;
  const ts = header(headers, 'x-slack-request-timestamp');
  const sig = header(headers, 'x-slack-signature');
  if (!ts || !sig || !/^\d+$/.test(ts)) return false;
  if (Math.abs(now - Number(ts) * 1000) > SLACK_TIMESTAMP_TOLERANCE_MS) return false;
  const expected = `v0=${hmacSha256Hex(secret, `v0:${ts}:${body.toString('utf8')}`)}`;
  return safeEqual(sig, expected);
}
