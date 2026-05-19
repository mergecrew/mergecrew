/**
 * Sandbox environment policy (#561).
 *
 * The runner supervisor's process.env is a hazard map of secrets:
 * KMS_MASTER_KEY, GITHUB_APP_PRIVATE_KEY, AWS_*, VERCEL_TOKEN,
 * BYOK LLM provider keys. Inheriting it into every subprocess (as
 * the V0 ProcessDriver did) gave any agent-driven build script
 * full access to all of them — see threat T-1/T-3/T-4 in #554.
 *
 * The fix is to start with a minimal allowed-base env and let the
 * caller layer on exactly the vars they want. Project-scoped secrets
 * come in via `opts.env` after the supervisor decrypts them per
 * request (purpose-audited).
 */

/**
 * The only `process.env` keys that flow into a sandbox by default.
 * Non-sensitive operational defaults the toolchain expects (paths,
 * locale, timezone, the universal "we're in CI" signal, color flag).
 *
 * Notably absent (intentional):
 *   - KMS_*, GITHUB_*, AWS_*, BEDROCK_*  (T-1/T-3/T-4)
 *   - VERCEL_*, NETLIFY_*, RENDER_*       (T-4)
 *   - ANTHROPIC_API_KEY, OPENAI_API_KEY   (supervisor-only)
 *   - DATABASE_URL, REDIS_URL             (no need in the sandbox)
 */
export const BASE_ALLOWED_ENV: readonly string[] = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'CI',
  'FORCE_COLOR',
  'NO_COLOR',
  'TERM',
];

/**
 * Prefixes that almost certainly point at a secret. When a skill
 * explicitly passes one through `opts.env`, the driver still honors
 * it (the supervisor might have a legitimate reason to inject a
 * scoped value), but it warns so the leak is visible in operator
 * telemetry.
 */
export const SENSITIVE_ENV_PREFIXES: readonly string[] = [
  'KMS_',
  'GITHUB_APP_',
  'GH_APP_',
  'AWS_',
  'BEDROCK_',
  'VERCEL_',
  'NETLIFY_',
  'RENDER_',
  'ANTHROPIC_',
  'OPENAI_',
  'OLLAMA_',
  'DATABASE_',
  'REDIS_',
  'JWT_',
  'SESSION_',
];

/**
 * Build the base env passed to every sandboxed subprocess. Includes
 * only `BASE_ALLOWED_ENV` keys that are actually set in the supervisor's
 * process.env — no defaults are invented.
 */
export function buildScrubbedEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of BASE_ALLOWED_ENV) {
    const v = source[key];
    if (v !== undefined) out[key] = v;
  }
  return out;
}

/** Returns the matching prefix, or undefined if the key looks benign. */
export function classifySensitiveKey(key: string): string | undefined {
  const upper = key.toUpperCase();
  for (const prefix of SENSITIVE_ENV_PREFIXES) {
    if (upper.startsWith(prefix)) return prefix;
  }
  return undefined;
}
