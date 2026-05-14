'use server';

import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';

/**
 * Create-org server action shared by the first-time landing on `/`
 * (zero-orgs branch) and the user-menu-driven `/orgs/new` page. Both
 * routes need the same POST + redirect path; keeping a single action
 * means the redesign at `/` and the lighter `/orgs/new` page can pass
 * the same `action` prop into the shared `<CreateOrgForm>` client
 * component without each page hand-rolling its own.
 *
 * After org creation, land in the seeded read-only `demo-saas`
 * project (#440) — the inverted FTE entry point. The wizard is the
 * "skip" path for operators ready to wire their own repo. Fall back
 * to the org home if no demo was seeded (self-hoster opted out via
 * `MERGECREW_SEED_DEMO_PROJECT=0`).
 */
export async function createOrgAction(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim();
  const slug = String(formData.get('slug') ?? '').trim();
  if (!name || !slug) return;
  const session = await requireSession();
  await api(`/v1/orgs`, {
    method: 'POST',
    body: JSON.stringify({ name, slug }),
    session,
  });
  // Probe for the demo project on the freshly-created org. If the
  // API seeded one (default), redirect into it; otherwise fall back
  // to the org home so the user still sees the wizard/setup card.
  const projects = await api<{ items: Array<{ slug: string; demo: boolean }> }>(
    `/v1/orgs/${slug}/projects`,
    { session },
  ).catch(() => ({ items: [] as Array<{ slug: string; demo: boolean }> }));
  const demo = projects.items.find((p) => p.demo);
  if (demo) {
    redirect(`/orgs/${slug}/projects/${demo.slug}`);
  }
  redirect(`/orgs/${slug}`);
}
