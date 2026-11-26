/**
 * Verified-email resolution for OAuth sign-ins. The API links an OAuth
 * identity to a Mergecrew account by email, so the BFF must only ever
 * assert an address the provider has verified:
 *
 *  - Google: the ID-token profile's `email_verified` must be `true`.
 *  - GitHub: the address must be the account's primary email AND marked
 *    verified in `GET /user/emails` (the provider's default profile falls
 *    back to an unverified address, so its `email` is not trusted).
 *
 * Any other provider is rejected. Pure functions; the GitHub fetch is
 * injected so this can be unit-tested.
 */

export interface GithubEmail {
  email: string;
  primary: boolean;
  verified: boolean;
}

export function verifiedGoogleEmail(profile: unknown): string | null {
  const p = profile as { email?: unknown; email_verified?: unknown } | null | undefined;
  if (!p || typeof p.email !== 'string' || !p.email) return null;
  // Strictly boolean true — a string "true" or a missing claim is rejected.
  if (p.email_verified !== true) return null;
  return p.email.trim();
}

export function verifiedGithubEmail(emails: unknown): string | null {
  if (!Array.isArray(emails)) return null;
  const primary = (emails as GithubEmail[]).find(
    (e) => e && e.primary === true && e.verified === true && typeof e.email === 'string' && e.email,
  );
  return primary ? primary.email.trim() : null;
}

export async function fetchGithubEmails(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GithubEmail[] | null> {
  try {
    const r = await fetchImpl('https://api.github.com/user/emails', {
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'mergecrew',
      },
      cache: 'no-store',
    });
    if (!r.ok) return null;
    return (await r.json()) as GithubEmail[];
  } catch {
    return null;
  }
}

/** Resolve the provider-verified email for a sign-in, or null to refuse it. */
export async function resolveVerifiedEmail(
  account: { provider?: string; access_token?: string } | null | undefined,
  profile: unknown,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!account?.provider) return null;
  if (account.provider === 'google') return verifiedGoogleEmail(profile);
  if (account.provider === 'github') {
    if (!account.access_token) return null;
    return verifiedGithubEmail(await fetchGithubEmails(account.access_token, fetchImpl));
  }
  return null;
}
