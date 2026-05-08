import { redirect } from 'next/navigation';

export default async function DigestRedirect({
  params,
}: {
  params: Promise<{ slug: string; projectSlug: string }>;
}) {
  const { slug, projectSlug } = await params;
  const today = new Date().toISOString().slice(0, 10);
  redirect(`/orgs/${slug}/projects/${projectSlug}/digest/${today}`);
}
