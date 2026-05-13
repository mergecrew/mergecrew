import type { EmailConfig, EmailProvider } from './email.js';

const FROM_DEFAULT = 'noreply@mergecrew.dev';

function parseProvider(v: string | undefined): EmailProvider | undefined {
  if (v === 'smtp' || v === 'resend' || v === 'auto') return v;
  return undefined;
}

/**
 * Single source of truth for reading email-provider config out of env
 * vars. Used by the three EmailClient construction sites (magic-link
 * service, digest-email worker, runner's composite comms provider) so
 * a future env-var rename or default change only happens here.
 *
 * Accepts an injected `env` for testability — defaults to process.env.
 */
export function emailConfigFromEnv(env: NodeJS.ProcessEnv = process.env): EmailConfig {
  return {
    from: env.MERGECREW_EMAIL_FROM ?? FROM_DEFAULT,
    smtpUrl: env.SMTP_URL || undefined,
    resendApiKey: env.RESEND_API_KEY || undefined,
    provider: parseProvider(env.EMAIL_PROVIDER),
  };
}

/**
 * True when at least one real email provider is configured. Used by
 * the orchestrator's email-dispatch gate and the digest worker's
 * prod-skip guard to decide whether to queue / send.
 */
export function emailEnabledFromEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return !!(env.SMTP_URL || env.RESEND_API_KEY);
}
