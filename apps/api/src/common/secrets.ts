import { timingSafeEqual } from 'node:crypto';

/**
 * Central accessors for the API's security-critical secrets.
 *
 * Outside production the historical dev defaults still apply so a fresh
 * checkout boots without configuration. In production (`NODE_ENV=production`)
 * `assertProductionSecrets()` runs before the app is created and refuses to
 * boot when a secret is missing or set to a value that ships in this repo
 * (`.env.example`, docker-compose.full.yml, docs), so a misconfigured deploy
 * fails loudly instead of running with publicly known keys.
 *
 * `MERGECREW_ALLOW_INSECURE_DEFAULTS=true` downgrades the refusal to a
 * warning. It exists only for the local trial stack (docker-compose.full.yml),
 * whose standalone images run with NODE_ENV=production on localhost.
 */

export const DEV_JWT_SECRET = 'dev-secret';
export const DEV_BFF_TRUST_TOKEN = 'dev-trust-token';
export const DEV_KMS_MASTER_KEY = 'base64:0000000000000000000000000000000000000000000=';

/** Values that appear in this repository and must never be used in production. */
export const KNOWN_INSECURE_SECRETS: ReadonlySet<string> = new Set([
  DEV_JWT_SECRET,
  DEV_BFF_TRUST_TOKEN,
  'change-me-in-prod',
  'change-me',
  'changeme',
  'secret',
]);

export const GENERATE_HINT =
  'Generate values with: openssl rand -hex 32  (KMS_MASTER_KEY: echo "base64:$(openssl rand -base64 32)")';

type Env = Record<string, string | undefined>;

function isProduction(env: Env): boolean {
  return env.NODE_ENV === 'production';
}

function insecureDefaultsAllowed(env: Env): boolean {
  return env.MERGECREW_ALLOW_INSECURE_DEFAULTS === 'true';
}

/**
 * True when the KMS key is missing, malformed, the published dev key
 * (`base64:000…=` — note that decodes to a fixed non-zero constant, not
 * zero bytes), or literally all-zero bytes.
 */
export function isInsecureKmsKey(v: string | undefined): boolean {
  if (!v || !v.trim().startsWith('base64:')) return true;
  if (v.trim() === DEV_KMS_MASTER_KEY) return true;
  const buf = Buffer.from(v.trim().slice(7), 'base64');
  if (buf.length !== 32) return true;
  return buf.every((b) => b === 0);
}

function isInsecureSecret(v: string | undefined): boolean {
  if (!v || !v.trim()) return true;
  return KNOWN_INSECURE_SECRETS.has(v.trim());
}

/** Returns a list of human-readable problems with the configured secrets. */
export function findSecretProblems(env: Env = process.env): string[] {
  const problems: string[] = [];
  if (isInsecureSecret(env.JWT_SECRET)) {
    problems.push('JWT_SECRET is missing or set to a known development default');
  }
  if (isInsecureSecret(env.BFF_TRUST_TOKEN)) {
    problems.push('BFF_TRUST_TOKEN is missing or set to a known development default');
  }
  if (isInsecureKmsKey(env.KMS_MASTER_KEY)) {
    problems.push('KMS_MASTER_KEY is missing, malformed, or the published development key');
  }
  return problems;
}

/**
 * Throws in production when any secret is missing or a known default.
 * No-op outside production. Call once, before the Nest app is created.
 */
export function assertProductionSecrets(env: Env = process.env): void {
  if (!isProduction(env)) return;
  const problems = findSecretProblems(env);
  if (problems.length === 0) return;
  const msg = `[api] refusing to start in production with insecure secrets:\n  - ${problems.join(
    '\n  - ',
  )}\n${GENERATE_HINT}`;
  if (insecureDefaultsAllowed(env)) {
    // eslint-disable-next-line no-console
    console.warn(`${msg}\n[api] MERGECREW_ALLOW_INSECURE_DEFAULTS=true — continuing anyway. Do not use this on a public deployment.`);
    return;
  }
  throw new Error(msg);
}

function requireOrDefault(name: string, devDefault: string, env: Env): string {
  const v = env[name];
  if (v && v.trim()) return v;
  if (isProduction(env) && !insecureDefaultsAllowed(env)) {
    throw new Error(`${name} must be set in production. ${GENERATE_HINT}`);
  }
  return devDefault;
}

/** Secret used to sign and verify session JWTs. */
export function jwtSecret(env: Env = process.env): string {
  return requireOrDefault('JWT_SECRET', DEV_JWT_SECRET, env);
}

/** Shared secret the web BFF presents to `/v1/auth/exchange`. */
export function bffTrustToken(env: Env = process.env): string {
  return requireOrDefault('BFF_TRUST_TOKEN', DEV_BFF_TRUST_TOKEN, env);
}

/** Envelope-encryption master key (`base64:` + 32 bytes). */
export function kmsMasterKey(env: Env = process.env): string {
  const v = env.KMS_MASTER_KEY;
  if (isProduction(env) && !insecureDefaultsAllowed(env) && isInsecureKmsKey(v)) {
    throw new Error(`KMS_MASTER_KEY must be a non-zero 32-byte key in production. ${GENERATE_HINT}`);
  }
  return v ?? DEV_KMS_MASTER_KEY;
}

/** Constant-time string comparison; false for missing values. */
export function safeEqual(presented: string | undefined | null, expected: string): boolean {
  if (typeof presented !== 'string' || !expected) return false;
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison so the length mismatch path costs the same.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
