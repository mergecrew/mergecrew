import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, Button } from '@/components/ui';
import { CreatedSecretCallout } from '@/components/created-secret-callout';
import { MfaRequiredCallout, isMfaGateError } from '@/components/mfa-required-callout';

interface ApiKeySummary {
  id: string;
  name: string;
  prefix: string;
  role: 'owner' | 'admin' | 'operator' | 'viewer';
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

interface IssueResponse {
  id: string;
  name: string;
  prefix: string;
  role: ApiKeySummary['role'];
  createdAt: string;
  token: string;
}

const ROLE_OPTIONS: ApiKeySummary['role'][] = ['operator', 'admin', 'viewer'];

async function issueAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const name = String(formData.get('name') ?? '').trim();
  const role = String(formData.get('role') ?? 'operator') as ApiKeySummary['role'];
  if (!name) return;
  const session = await requireSession();
  const issued = await api<IssueResponse>(`/v1/orgs/${slug}/api-keys`, {
    method: 'POST',
    body: JSON.stringify({ name, role }),
    session,
  });
  // One-time-display: stash the plaintext token in a short-lived cookie
  // scoped to this page so the next render can show it once.
  const { cookies } = await import('next/headers');
  (await cookies()).set(`mc-apikey-token-${issued.id}`, issued.token, {
    maxAge: 60,
    path: `/orgs/${slug}/settings/api-keys`,
    httpOnly: true,
  });
  revalidatePath(`/orgs/${slug}/settings/api-keys`);
}

async function revokeAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/api-keys/${id}`, { method: 'DELETE', session });
  revalidatePath(`/orgs/${slug}/settings/api-keys`);
}

export default async function ApiKeysPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  const canEdit = await hasRole(slug, session, 'admin');

  // The list endpoint requires admin role, which triggers the RoleGuard's
  // MFA gate. Catch that specific error so unenrolled admins land on a
  // clear CTA instead of a 500.
  let list: { items: ApiKeySummary[] };
  let mfaBlocked = false;
  try {
    list = await api<{ items: ApiKeySummary[] }>(`/v1/orgs/${slug}/api-keys`, { session });
  } catch (err) {
    if (canEdit && isMfaGateError(err)) {
      mfaBlocked = true;
      list = { items: [] };
    } else {
      throw err;
    }
  }

  const { cookies } = await import('next/headers');
  const ck = await cookies();
  const justIssued = list.items
    .map((k) => ({ k, token: ck.get(`mc-apikey-token-${k.id}`)?.value }))
    .find((x) => x.token);

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">API keys</h1>
        <p className="text-sm text-zinc-500">
          Programmatic access for SDKs (TS, Python) and CI tooling. Tokens look like{' '}
          <code>mc_live_…</code> and are shown <strong>exactly once</strong> at creation.
        </p>
      </header>

      {justIssued && (
        <CreatedSecretCallout
          secret={justIssued.token!}
          label={`API token for "${justIssued.k.name}"`}
        />
      )}

      {mfaBlocked && <MfaRequiredCallout />}

      {canEdit && !mfaBlocked && (
        <Card>
          <h2 className="font-medium">Issue key</h2>
          <form action={issueAction} className="mt-3 space-y-2 text-sm">
            <input type="hidden" name="slug" value={slug} />
            <label className="block">
              <span className="text-zinc-600 dark:text-zinc-400">Name</span>
              <input
                name="name"
                required
                placeholder="ci-bot"
                className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
              />
            </label>
            <label className="block">
              <span className="text-zinc-600 dark:text-zinc-400">Role</span>
              <select
                name="role"
                defaultValue="operator"
                className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
              >
                {ROLE_OPTIONS.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
            <Button variant="primary" type="submit">
              Issue
            </Button>
          </form>
        </Card>
      )}

      <Card>
        <h2 className="font-medium">Active keys</h2>
        {list.items.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No API keys yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            {list.items.map((k) => (
              <li key={k.id} className="flex items-baseline justify-between gap-3 py-2">
                <div className="min-w-0">
                  <div className="font-medium">{k.name}</div>
                  <div className="text-xs text-zinc-500">
                    <code className="font-mono">{k.prefix}…</code>
                    <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-zinc-800">
                      {k.role}
                    </span>
                    {k.lastUsedAt ? (
                      <span className="ml-2">
                        last used {new Date(k.lastUsedAt).toLocaleString()}
                      </span>
                    ) : (
                      <span className="ml-2">never used</span>
                    )}
                    {k.revokedAt && (
                      <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                        revoked
                      </span>
                    )}
                  </div>
                </div>
                {canEdit && !k.revokedAt && (
                  <form action={revokeAction}>
                    <input type="hidden" name="slug" value={slug} />
                    <input type="hidden" name="id" value={k.id} />
                    <Button variant="destructive" type="submit">
                      Revoke
                    </Button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
