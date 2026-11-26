/**
 * Web/BFF secret checks. In production (`NODE_ENV=production`) the server
 * refuses to start (see src/instrumentation.ts) when NEXTAUTH_SECRET /
 * AUTH_SECRET or BFF_TRUST_TOKEN is missing or a value that ships in this
 * repository. `MERGECREW_ALLOW_INSECURE_DEFAULTS=true` downgrades that to a
 * warning for the localhost trial stack only. Pure: no Next.js imports.
 */

const DEV_BFF_TRUST_TOKEN = 'dev-trust-token';

const KNOWN_INSECURE = new Set([
  'dev-secret',
  DEV_BFF_TRUST_TOKEN,
  'change-me-in-prod',
  'change-me',
  'changeme',
  'secret',
]);

type Env = Record<string, string | undefined>;

function insecure(v: string | undefined): boolean {
  return !v || !v.trim() || KNOWN_INSECURE.has(v.trim());
}

export function findWebSecretProblems(env: Env = process.env): string[] {
  const problems: string[] = [];
  if (insecure(env.AUTH_SECRET ?? env.NEXTAUTH_SECRET)) {
    problems.push('NEXTAUTH_SECRET (or AUTH_SECRET) is missing or set to a known development default');
  }
  if (insecure(env.BFF_TRUST_TOKEN)) {
    problems.push('BFF_TRUST_TOKEN is missing or set to a known development default');
  }
  return problems;
}

/**
 * Returns an error message when the server must not start, null otherwise.
 * Logs a warning instead when the insecure-defaults escape hatch is set.
 */
export function productionSecretsError(env: Env = process.env): string | null {
  if (env.NODE_ENV !== 'production') return null;
  const problems = findWebSecretProblems(env);
  if (problems.length === 0) return null;
  const msg =
    `[web] refusing to start in production with insecure secrets:\n  - ${problems.join('\n  - ')}\n` +
    'Generate values with: openssl rand -hex 32';
  if (env.MERGECREW_ALLOW_INSECURE_DEFAULTS === 'true') {
    console.warn(`${msg}\n[web] MERGECREW_ALLOW_INSECURE_DEFAULTS=true — continuing anyway. Do not use this on a public deployment.`);
    return null;
  }
  return msg;
}

/** Shared secret presented to the API's /v1/auth/exchange. */
export function bffTrustToken(env: Env = process.env): string {
  const v = env.BFF_TRUST_TOKEN;
  if (v && v.trim()) return v;
  // Production without a token already failed the boot check; the dev
  // default only ever applies outside production.
  return env.NODE_ENV === 'production' && env.MERGECREW_ALLOW_INSECURE_DEFAULTS !== 'true'
    ? ''
    : DEV_BFF_TRUST_TOKEN;
}
