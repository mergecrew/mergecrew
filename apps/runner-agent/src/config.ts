/**
 * Agent config resolution (V2.af / #764).
 *
 * Flags override env, env overrides defaults. Token + API URL are
 * required for any non-dry-run mode; the agent refuses to start
 * without them.
 *
 * Token is hashed at the server (ADR-0004); the agent only ever holds
 * the plaintext bearer to attach as `Authorization: Bearer <token>`.
 */
export interface AgentConfig {
  /** Bearer token issued from the org settings UI (#765). */
  token: string;
  /** API base URL — e.g. https://mergecrew.dev or http://localhost:4000. */
  apiUrl: string;
  /** Friendly name surfaced in the org's agent list. Defaults to os.hostname(). */
  name: string;
  /** Sandbox driver to use locally for received jobs. */
  driver: 'process' | 'docker';
  /** Print the resolved config and exit. */
  dryRun: boolean;
  /** Poll concurrency — how many jobs the agent processes in parallel. */
  concurrency: number;
}

export interface ResolveArgs {
  argv: string[];
  env: NodeJS.ProcessEnv;
  hostname: () => string;
}

function flagValue(argv: string[], name: string): string | undefined {
  // Supports both `--name value` and `--name=value`.
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === name) return argv[i + 1];
    if (a.startsWith(`${name}=`)) return a.slice(name.length + 1);
  }
  return undefined;
}

function flagPresent(argv: string[], name: string): boolean {
  return argv.includes(name);
}

export function resolveAgentConfig({ argv, env, hostname }: ResolveArgs): AgentConfig {
  const token = flagValue(argv, '--token') ?? env.MERGECREW_AGENT_TOKEN ?? '';
  const apiUrl =
    flagValue(argv, '--api-url') ??
    env.MERGECREW_API_URL ??
    '';
  const name = flagValue(argv, '--name') ?? env.MERGECREW_AGENT_NAME ?? hostname();
  const driverRaw =
    flagValue(argv, '--driver') ?? env.MERGECREW_AGENT_DRIVER ?? 'docker';
  if (driverRaw !== 'process' && driverRaw !== 'docker') {
    throw new Error(
      `invalid --driver "${driverRaw}" — expected 'process' or 'docker'`,
    );
  }
  const dryRun = flagPresent(argv, '--dry-run') || env.MERGECREW_AGENT_DRY_RUN === '1';
  const concurrency = Math.max(
    1,
    Number(flagValue(argv, '--concurrency') ?? env.MERGECREW_AGENT_CONCURRENCY ?? '1'),
  );
  return { token, apiUrl, name, driver: driverRaw, dryRun, concurrency };
}

/**
 * Best-effort token prefix for display — matches the `mca_<orgSlug>_<6>`
 * shape stored server-side (ADR-0004) but never echoes the full secret.
 * Falls back to a short hash-y view if the token doesn't match the shape.
 */
export function tokenPrefix(token: string): string {
  if (!token) return '<unset>';
  const m = token.match(/^(mca_[a-z0-9-]+_[A-Z0-9]{1,6})/i);
  if (m && m[1]) return m[1];
  return token.length <= 8 ? '****' : `${token.slice(0, 4)}…${token.slice(-2)}`;
}

/** Assertion suitable for non-dry-run startup. Throws on missing required fields. */
export function assertConfigUsable(cfg: AgentConfig): void {
  const missing: string[] = [];
  if (!cfg.token) missing.push('--token (or MERGECREW_AGENT_TOKEN)');
  if (!cfg.apiUrl) missing.push('--api-url (or MERGECREW_API_URL)');
  if (missing.length > 0) {
    throw new Error(`missing required config: ${missing.join(', ')}`);
  }
  try {
    new URL(cfg.apiUrl);
  } catch {
    throw new Error(`invalid --api-url "${cfg.apiUrl}" — must be a URL`);
  }
}
