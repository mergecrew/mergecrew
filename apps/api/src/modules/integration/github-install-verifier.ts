/**
 * Proves, via GitHub, that the person completing the install flow can
 * actually access the installation id the callback received.
 *
 * GitHub's docs are explicit that the `installation_id` query parameter
 * on the setup URL can be spoofed. The recommended check is to obtain a
 * user access token for the GitHub user (OAuth web flow of the GitHub
 * App, using its client id / secret) and confirm the installation is
 * listed by `GET /user/installations` for that token.
 */

export interface GitHubOAuthConfig {
  clientId: string;
  clientSecret: string;
  /**
   * Must match one of the App's registered Callback URLs. Omitted when
   * unset, in which case GitHub uses the first registered Callback URL.
   */
  redirectUri?: string;
  /** https://github.com (or a GHES origin). */
  webBaseUrl: string;
  /** https://api.github.com (or `<GHES>/api/v3`). */
  apiBaseUrl: string;
}

export type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export function githubOAuthConfigFromEnv(env: NodeJS.ProcessEnv = process.env): GitHubOAuthConfig | null {
  const clientId = env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = env.GITHUB_APP_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  const publicApi = env.MERGECREW_PUBLIC_API_BASE_URL?.trim().replace(/\/+$/, '');
  const redirectUri =
    env.GITHUB_APP_INSTALL_REDIRECT_URI?.trim() ||
    (publicApi ? `${publicApi}/v1/integrations/github/install/callback` : undefined);
  return {
    clientId,
    clientSecret,
    redirectUri,
    webBaseUrl: 'https://github.com',
    apiBaseUrl: 'https://api.github.com',
  };
}

/** URL that asks GitHub to authorize the user and redirect back with `code`. */
export function buildAuthorizeUrl(cfg: GitHubOAuthConfig, state: string): string {
  const u = new URL('/login/oauth/authorize', cfg.webBaseUrl);
  u.searchParams.set('client_id', cfg.clientId);
  u.searchParams.set('state', state);
  if (cfg.redirectUri) u.searchParams.set('redirect_uri', cfg.redirectUri);
  return u.toString();
}

export class GitHubVerifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubVerifyError';
  }
}

export async function exchangeCodeForUserToken(
  cfg: GitHubOAuthConfig,
  code: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<string> {
  const body: Record<string, string> = {
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    code,
  };
  if (cfg.redirectUri) body.redirect_uri = cfg.redirectUri;
  const r = await fetchImpl(new URL('/login/oauth/access_token', cfg.webBaseUrl).toString(), {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new GitHubVerifyError(`oauth token exchange failed (${r.status})`);
  const j = (await r.json()) as { access_token?: unknown; error?: unknown };
  if (typeof j.access_token !== 'string' || !j.access_token) {
    throw new GitHubVerifyError(`oauth token exchange rejected (${String(j.error ?? 'no token')})`);
  }
  return j.access_token;
}

const PER_PAGE = 100;
const MAX_PAGES = 20;

/**
 * Looks for `installationId` among the installations the user token can
 * access. Returns the installation's account login when found, `null`
 * when the user can't access it.
 */
export async function findUserInstallation(
  cfg: GitHubOAuthConfig,
  userToken: string,
  installationId: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<{ installationId: string; accountLogin: string | null } | null> {
  for (let page = 1; page <= MAX_PAGES; page++) {
    const u = new URL('/user/installations', cfg.apiBaseUrl);
    u.searchParams.set('per_page', String(PER_PAGE));
    u.searchParams.set('page', String(page));
    const r = await fetchImpl(u.toString(), {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${userToken}`,
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!r.ok) throw new GitHubVerifyError(`GET /user/installations failed (${r.status})`);
    const j = (await r.json()) as { installations?: unknown };
    const list = Array.isArray(j.installations) ? j.installations : [];
    for (const inst of list as Array<{ id?: unknown; account?: { login?: unknown } | null }>) {
      if (String(inst?.id) === installationId) {
        const login = inst.account?.login;
        return { installationId, accountLogin: typeof login === 'string' ? login : null };
      }
    }
    if (list.length < PER_PAGE) return null;
  }
  return null;
}
