import { ValidationError } from '@mergecrew/domain';

/**
 * Outbound secret scanner.
 *
 * Everything an agent can make leave the platform — PR titles / bodies,
 * review and comment text, commit messages, branch names, HTTP skill
 * bodies and URLs, pushed diffs — is scanned before it is sent. Text
 * containing a well-known credential shape, or the exact value of one of
 * the supervisor's own secret env vars (or a value registered at runtime,
 * e.g. a minted installation token or a decrypted tenant secret), is
 * refused.
 *
 * Findings never echo the secret itself — only its kind and where it
 * was found — so the rejection message is safe to log and to hand back
 * to the model.
 */

export interface SecretFinding {
  kind: string;
  /** Where in the scanned value the hit was found (e.g. `input.body`). */
  location: string;
}

export class OutboundSecretError extends ValidationError {
  readonly findings: SecretFinding[];
  constructor(label: string, findings: SecretFinding[]) {
    const kinds = [...new Set(findings.map((f) => f.kind))].join(', ');
    const where = [...new Set(findings.map((f) => f.location))].slice(0, 5).join(', ');
    super(`outbound ${label} blocked: contains secret material (${kinds}) at ${where}`, {
      code: 'outbound_secret',
      kinds: [...new Set(findings.map((f) => f.kind))],
    });
    this.name = 'OutboundSecretError';
    this.findings = findings;
  }
}

const PATTERNS: Array<{ kind: string; re: RegExp }> = [
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{30,255}\b/ },
  { kind: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{22,255}\b/ },
  { kind: 'gitlab_token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { kind: 'aws_access_key_id', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
  { kind: 'private_key', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/ },
  { kind: 'anthropic_api_key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'api_secret_key', re: /\bsk-(?:[a-z]+-)?[A-Za-z0-9]{20,}/ },
  { kind: 'mergecrew_api_key', re: /\bmc_live_[A-Za-z0-9_-]{16,}/ },
  { kind: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/ },
];

/** Env var names that hold secrets (values are matched exactly). */
const SECRET_ENV_NAME =
  /(SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE|CREDENTIAL|SIGNING|API_KEY|ACCESS_KEY|MASTER_KEY|_KEY$|^KEY$|DATABASE.*URL|REDIS.*URL|_DSN$|^DSN$|WEBHOOK)/i;

const MIN_SECRET_LEN = 12;

/**
 * Exact-value matching only for values that look like secrets: long
 * enough and not a plain word (a dev DB password like `mergecrew` must
 * not block every branch name).
 */
function looksSecretish(v: string): boolean {
  if (v.length < MIN_SECRET_LEN) return false;
  if (/^(true|false|yes|no|on|off|\d+)$/i.test(v)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(v)).length;
  return classes >= 2 || v.length >= 24;
}

const registered = new Set<string>();

/**
 * Register a runtime secret (installation token, decrypted tenant
 * secret, …) so outbound text containing it is refused for the rest of
 * the process lifetime.
 */
export function registerKnownSecret(value: string | null | undefined): void {
  if (typeof value === 'string' && value.length >= MIN_SECRET_LEN) registered.add(value);
}

/** Test seam. */
export function __clearRegisteredSecretsForTests(): void {
  registered.clear();
}

function expand(value: string): string[] {
  const out = [value];
  // Multi-line secrets (PEM keys): match any substantial line on its own.
  if (value.includes('\n')) {
    for (const line of value.split(/\r?\n/)) {
      const t = line.trim();
      if (t.length >= 24 && !t.startsWith('-----')) out.push(t);
    }
  }
  // Escaped-newline PEMs (common in .env files).
  if (value.includes('\\n')) out.push(...expand(value.split('\\n').join('\n')).slice(1));
  // URLs with embedded passwords (DATABASE_URL etc.): the password alone.
  try {
    const u = new URL(value);
    if (u.password) out.push(decodeURIComponent(u.password));
  } catch {
    /* not a URL */
  }
  return out.filter(looksSecretish);
}

/** Exact secret values the scanner matches, from env + registrations. */
export function knownSecretValues(env: NodeJS.ProcessEnv = process.env): string[] {
  const values = new Set<string>();
  for (const [k, v] of Object.entries(env)) {
    if (!v || v.length < MIN_SECRET_LEN) continue;
    if (!SECRET_ENV_NAME.test(k)) continue;
    for (const e of expand(v)) values.add(e);
  }
  for (const v of registered) for (const e of expand(v)) values.add(e);
  return [...values];
}

export interface ScanOpts {
  env?: NodeJS.ProcessEnv;
  /** Extra exact values to match (per call). */
  extraValues?: readonly string[];
}

/** Scan one string. Returns the kinds of secret material found. */
export function scanText(text: string, location = 'text', opts: ScanOpts = {}): SecretFinding[] {
  if (typeof text !== 'string' || text.length === 0) return [];
  const findings: SecretFinding[] = [];
  for (const { kind, re } of PATTERNS) {
    if (re.test(text)) findings.push({ kind, location });
  }
  const values = [...knownSecretValues(opts.env), ...(opts.extraValues ?? [])];
  for (const v of values) {
    if (v.length >= MIN_SECRET_LEN && text.includes(v)) {
      findings.push({ kind: 'known_secret_value', location });
      break;
    }
  }
  return findings;
}

/** Recursively scan every string (and object key) inside `value`. */
export function scanValue(value: unknown, location = 'input', opts: ScanOpts = {}): SecretFinding[] {
  const out: SecretFinding[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown, loc: string, depth: number) => {
    if (depth > 32) return;
    if (typeof v === 'string') {
      out.push(...scanText(v, loc, opts));
      return;
    }
    if (!v || typeof v !== 'object' || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      v.forEach((item, i) => visit(item, `${loc}[${i}]`, depth + 1));
      return;
    }
    for (const [k, item] of Object.entries(v as Record<string, unknown>)) {
      out.push(...scanText(k, `${loc}.<key>`, opts));
      visit(item, `${loc}.${k}`, depth + 1);
    }
  };
  visit(value, location, 0);
  return out;
}

/** Throw `OutboundSecretError` when `text` carries secret material. */
export function assertNoSecrets(text: string, label: string, opts: ScanOpts = {}): void {
  const f = scanText(text, label, opts);
  if (f.length > 0) throw new OutboundSecretError(label, f);
}

/** Throw `OutboundSecretError` when any string inside `value` carries secret material. */
export function assertNoSecretsInValue(value: unknown, label: string, opts: ScanOpts = {}): void {
  const f = scanValue(value, label, opts);
  if (f.length > 0) throw new OutboundSecretError(label, f);
}
