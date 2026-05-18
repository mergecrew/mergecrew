import { readFileSync } from 'node:fs';

export interface GitHubAppCredentials {
  appId: string;
  privateKey: string;
  clientId?: string;
  clientSecret?: string;
}

/**
 * Read GitHub App credentials from the environment.
 *
 * Two ways to provide the private key, in priority order:
 *
 *   1. `GITHUB_APP_PRIVATE_KEY_FILE` — absolute path to the `.pem`. The
 *      standard Kubernetes / docker-secrets / SOPS pattern: mount the
 *      file read-only into the container (e.g.
 *      `./secrets/github-app.pem:/app/secrets/github-app.pem:ro`) and
 *      set this env var to the path inside the container.
 *
 *   2. `GITHUB_APP_PRIVATE_KEY` — PEM contents inline. Wrap the
 *      multi-line PEM in double quotes in `.env`; modern dotenv (and
 *      docker compose v2.x) preserve real newlines inside quoted
 *      values, which is what node:crypto / octokit need.
 *
 * Returns `null` when no app is configured. Callers that strictly require
 * the App should use {@link requireGitHubAppCredentials}.
 */
export function getGitHubAppCredentials(): GitHubAppCredentials | null {
  const appId = process.env.GITHUB_APP_ID?.trim();
  if (!appId) return null;

  const fromFile = readPrivateKeyFromFile(process.env.GITHUB_APP_PRIVATE_KEY_FILE);
  const fromEnv = process.env.GITHUB_APP_PRIVATE_KEY?.trim() || null;
  const privateKey = fromFile ?? fromEnv;
  if (!privateKey) return null;

  return {
    appId,
    privateKey,
    clientId: process.env.GITHUB_APP_CLIENT_ID?.trim() || undefined,
    clientSecret: process.env.GITHUB_APP_CLIENT_SECRET?.trim() || undefined,
  };
}

/**
 * Like {@link getGitHubAppCredentials} but throws when the App isn't
 * configured. `reason` is used in the error message to make the call-site
 * obvious to an operator reading logs.
 */
export function requireGitHubAppCredentials(reason: string): GitHubAppCredentials {
  const c = getGitHubAppCredentials();
  if (!c) {
    throw new Error(
      `${reason} requires GITHUB_APP_ID and a private key — set GITHUB_APP_PRIVATE_KEY_FILE (path to the .pem) or GITHUB_APP_PRIVATE_KEY (inline PEM, wrap multi-line in double quotes in .env).`,
    );
  }
  return c;
}

function readPrivateKeyFromFile(path: string | undefined): string | null {
  const p = path?.trim();
  if (!p) return null;
  let contents: string;
  try {
    contents = readFileSync(p, 'utf8');
  } catch (e: any) {
    throw new Error(`failed to read GITHUB_APP_PRIVATE_KEY_FILE at ${p}: ${e?.message ?? e}`);
  }
  const trimmed = contents.trim();
  return trimmed || null;
}
