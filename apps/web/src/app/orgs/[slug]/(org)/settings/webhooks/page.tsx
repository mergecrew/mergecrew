import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, Button } from '@/components/ui';
import { TestWebhookButton } from '@/components/test-webhook-button';
import { CreatedSecretCallout } from '@/components/created-secret-callout';
import { WebhookDeliveriesLog, type DeliveryRow } from '@/components/webhook-deliveries-log';
import { MfaRequiredCallout } from '@/components/mfa-required-callout';

interface WebhookSummary {
  id: string;
  url: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  lastDeliveredAt: string | null;
  failureCount: number;
}

interface CreateResponse {
  id: string;
  url: string;
  events: string[];
  secret: string;
}

async function createWebhookAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const url = String(formData.get('url') ?? '').trim();
  const events = String(formData.get('events') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!url) return;
  const session = await requireSession();
  const created = await api<CreateResponse>(`/v1/orgs/${slug}/webhooks`, {
    method: 'POST',
    body: JSON.stringify({ url, events }),
    session,
  });
  // Stash the one-time secret in a cookie so the next render can show it.
  // Server actions can't return values to a redirect; cookie round-trip is the
  // simplest mechanism without inventing client state for one render.
  const { cookies } = await import('next/headers');
  (await cookies()).set(`mc-webhook-secret-${created.id}`, created.secret, {
    maxAge: 60,
    path: `/orgs/${slug}/settings/webhooks`,
    httpOnly: true,
  });
  revalidatePath(`/orgs/${slug}/settings/webhooks`);
}

async function deleteWebhookAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const id = String(formData.get('id') ?? '');
  if (!id) return;
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/webhooks/${id}`, { method: 'DELETE', session });
  revalidatePath(`/orgs/${slug}/settings/webhooks`);
}

export default async function WebhooksPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const session = await requireSession();
  const canEdit = await hasRole(slug, session, 'admin');

  const list = await api<{ items: WebhookSummary[] }>(
    `/v1/orgs/${slug}/webhooks`,
    { session },
  );

  // MFA is recommended for admin/owner accounts but not enforced. When
  // the caller is admin and hasn't enrolled, surface a passive nudge —
  // the form below stays usable.
  let showMfaNudge = false;
  if (canEdit) {
    const mfa = await api<{ enrolled: boolean }>('/v1/me/mfa', { session }).catch(
      () => ({ enrolled: false }),
    );
    showMfaNudge = !mfa.enrolled;
  }

  const { cookies } = await import('next/headers');
  const ck = await cookies();
  const justCreated = list.items
    .map((w) => ({ w, secret: ck.get(`mc-webhook-secret-${w.id}`)?.value }))
    .find((x) => x.secret);

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Outbound webhooks</h1>
        <p className="text-sm text-zinc-500">
          POSTs to your endpoints when matching timeline events fire. Each delivery is signed —
          verify with <code>verifyWebhook()</code> from <code>@mergecrew/sdk</code>.
        </p>
      </header>

      {justCreated && (
        <CreatedSecretCallout
          secret={justCreated.secret!}
          label={`Signing secret for ${justCreated.w.url}`}
        />
      )}

      {showMfaNudge && <MfaRequiredCallout />}

      {canEdit && (
        <Card>
          <h2 className="font-medium">Add webhook</h2>
          <form action={createWebhookAction} className="mt-3 space-y-2 text-sm">
            <input type="hidden" name="slug" value={slug} />
            <label className="block">
              <span className="text-zinc-600 dark:text-zinc-400">URL</span>
              <input
                name="url"
                required
                placeholder="https://hooks.example.com/mergecrew"
                className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
              />
            </label>
            <label className="block">
              <span className="text-zinc-600 dark:text-zinc-400">
                Events (comma-separated, blank = all)
              </span>
              <input
                name="events"
                placeholder="RUN_COMPLETED, CHANGESET_OPENED"
                className="mt-1 w-full rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700"
              />
            </label>
            <Button variant="primary" type="submit">
              Add
            </Button>
          </form>
        </Card>
      )}

      <Card>
        <h2 className="font-medium">Active webhooks</h2>
        {list.items.length === 0 ? (
          <p className="mt-2 text-sm text-zinc-500">No webhooks yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
            {list.items.map((w) => (
              <li key={w.id} className="space-y-2 py-2">
                <div className="flex items-baseline justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-mono">{w.url}</div>
                    <div className="text-xs text-zinc-500">
                      {w.events.length === 0 ? 'all events' : w.events.join(', ')}
                      {w.failureCount > 0 && (
                        <span className="ml-2 rounded bg-red-100 px-1.5 py-0.5 text-red-700 dark:bg-red-900/40 dark:text-red-300">
                          {w.failureCount} failures
                        </span>
                      )}
                    </div>
                  </div>
                  {canEdit && (
                  <div className="flex shrink-0 gap-2">
                    <TestWebhookButton
                      onTest={async () => {
                        'use server';
                        try {
                          await api(`/v1/orgs/${slug}/webhooks/${w.id}/test`, {
                            method: 'POST',
                            body: '{}',
                            session: await requireSession(),
                          });
                          return { ok: true } as const;
                        } catch (e: any) {
                          return { ok: false, error: String(e?.message ?? e) } as const;
                        }
                      }}
                    />
                    <form action={deleteWebhookAction}>
                      <input type="hidden" name="slug" value={slug} />
                      <input type="hidden" name="id" value={w.id} />
                      <Button variant="destructive" type="submit">
                        Remove
                      </Button>
                    </form>
                  </div>
                  )}
                </div>
                <WebhookDeliveriesLog
                  load={async () => {
                    'use server';
                    try {
                      const res = await api<{ items: DeliveryRow[] }>(
                        `/v1/orgs/${slug}/webhooks/${w.id}/deliveries?limit=50`,
                        { session: await requireSession() },
                      );
                      return { ok: true as const, items: res.items };
                    } catch (e: any) {
                      return { ok: false as const, error: String(e?.message ?? e) };
                    }
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </main>
  );
}
