import { NextResponse } from 'next/server';
import { getSession } from '@/lib/session';
import { publicOrigin } from '@/lib/public-origin';

const API_BASE = process.env.API_BASE_URL ?? 'http://localhost:4000';

/**
 * Last hop of the GitHub App install flow.
 *
 * The API callback verified with GitHub that the installing GitHub user
 * can access the installation and handed us a short-lived signed
 * `grant`. We redeem it with the signed-in user's own session — the API
 * only writes the org ↔ installation binding when the grant was issued
 * to this same user and org — then send the browser to the wizard or
 * project settings with `installation_id` so the repo picker can load.
 */
export async function GET(
  req: Request,
  ctx: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await ctx.params;
  const url = new URL(req.url);
  const origin = publicOrigin(req);
  const grant = url.searchParams.get('grant') ?? '';
  const orgPath = `/orgs/${encodeURIComponent(slug)}`;

  if (!grant) {
    return NextResponse.redirect(new URL(`${orgPath}?github_install_error=bad_callback`, origin), { status: 302 });
  }

  const session = await getSession();
  if (!session) {
    const back = encodeURIComponent(`${orgPath}/github-install/complete?grant=${encodeURIComponent(grant)}`);
    return NextResponse.redirect(new URL(`/login?next=${back}`, origin), { status: 302 });
  }

  const r = await fetch(`${API_BASE}/v1/orgs/${encodeURIComponent(slug)}/github/installations/confirm`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${session.jwt}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ grant }),
    cache: 'no-store',
  });

  if (!r.ok) {
    let code = `confirm_${r.status}`;
    try {
      const j = (await r.json()) as { error?: { code?: string } };
      if (j?.error?.code === 'INSTALLATION_BOUND_TO_OTHER_ORG') code = 'installation_bound_to_other_org';
    } catch {
      /* keep the status-derived code */
    }
    return NextResponse.redirect(new URL(`${orgPath}?github_install_error=${code}`, origin), { status: 302 });
  }

  const body = (await r.json()) as {
    installationId: string;
    projectSlug: string;
    from: 'wizard' | 'settings';
    setupAction: string | null;
  };
  const installQuery = new URLSearchParams({
    installation_id: body.installationId,
    from: 'github_install',
    setup_action: body.setupAction ?? '',
  }).toString();
  let target: string;
  if (body.from === 'wizard') {
    target = `${orgPath}/onboarding?${installQuery}`;
  } else if (body.projectSlug) {
    target = `${orgPath}/projects/${encodeURIComponent(body.projectSlug)}/settings?${installQuery}`;
  } else {
    target = `${orgPath}?installation_id=${encodeURIComponent(body.installationId)}&from=github_install`;
  }
  return NextResponse.redirect(new URL(target, origin), { status: 302 });
}
