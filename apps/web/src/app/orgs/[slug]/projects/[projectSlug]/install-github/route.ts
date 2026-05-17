import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { publicOrigin } from '@/lib/public-origin';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

/**
 * BFF proxy for the GitHub App install flow (#457).
 *
 * The API's `/v1/integrations/github/install` endpoint requires a
 * `Bearer` JWT on the `Authorization` header — set server-side by the
 * web tier's `api()` wrapper. A direct browser navigation to the API
 * carries cookies but no Authorization header, so in production
 * deployments where web and API are on separate subdomains the install
 * link 401s.
 *
 * This route runs on the web tier (so the session cookie is in scope),
 * forwards to the API with the correct auth, and bounces the browser
 * to the GitHub URL the API replies with. The `from` query — `wizard`
 * or `settings` — is passed through so the API's callback redirects
 * the user back to the originating surface.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string; projectSlug: string }> },
): Promise<Response> {
  const { slug, projectSlug } = await ctx.params;
  const url = new URL(req.url);
  const from = url.searchParams.get('from') === 'wizard' ? 'wizard' : 'settings';
  // `req.url` is the internal container origin behind a reverse proxy;
  // use the public origin for any redirect that lands in the user's
  // browser (#459, same fix as the magic-link route).
  const origin = publicOrigin(req);

  const session = await getSession();
  if (!session) {
    // Bounce to /login; preserve a return target so the user lands
    // back on the wizard / settings page after authenticating.
    const back = encodeURIComponent(`/orgs/${slug}/projects/${projectSlug}/install-github?from=${from}`);
    return NextResponse.redirect(new URL(`/login?next=${back}`, origin), { status: 302 });
  }

  const apiUrl = `${API_BASE}/v1/integrations/github/install?org=${encodeURIComponent(slug)}&project=${encodeURIComponent(projectSlug)}&from=${from}`;
  const r = await fetch(apiUrl, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${session.jwt}`,
      'x-mergecrew-user-id': session.userId,
    },
    redirect: 'manual',
    cache: 'no-store',
  });

  // The API replies with 302 → github.com/apps/.../installations/new.
  // Forward that Location to the browser.
  const location = r.headers.get('location');
  if (r.status >= 300 && r.status < 400 && location) {
    return NextResponse.redirect(location, { status: 302 });
  }
  // Anything else is a server error from the API's side. Surface it
  // as a flash query param so the wizard / settings page can show
  // the operator a hint, then send them back.
  const fallbackPath =
    from === 'wizard' ? `/orgs/${slug}/onboarding` : `/orgs/${slug}/projects/${projectSlug}/settings`;
  return NextResponse.redirect(
    new URL(`${fallbackPath}?github_install_error=upstream_${r.status}`, origin),
    { status: 302 },
  );
}
