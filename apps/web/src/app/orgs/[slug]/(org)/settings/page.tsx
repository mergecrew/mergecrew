import { revalidatePath } from 'next/cache';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, Button } from '@/components/ui';
import { LlmProvidersCard } from '@/components/llm-providers-card';

interface BudgetInfo {
  dailyBudgetUsd: number | null;
  todaysSpendUsd: number;
  remainingUsd: number | null;
  exceeded: boolean;
}

async function setBudgetAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const raw = String(formData.get('dailyBudgetUsd') ?? '').trim();
  const parsed = raw === '' ? null : Number(raw);
  if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) return;
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/budget`, {
    method: 'PATCH',
    body: JSON.stringify({ dailyBudgetUsd: parsed }),
    session,
  });
  revalidatePath(`/orgs/${slug}/settings`);
}

export default async function OrgSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const [org, members, providers, budget, canEdit] = await Promise.all([
    api<any>(`/v1/orgs/${slug}`, { session }),
    api<{ items: any[] }>(`/v1/orgs/${slug}/members`, { session }),
    api<{ items: any[] }>(`/v1/orgs/${slug}/llm/providers`, { session }),
    api<BudgetInfo>(`/v1/orgs/${slug}/budget`, { session }),
    hasRole(slug, session, 'admin'),
  ]);

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-zinc-500">Org &nbsp;<code>{org.slug}</code></p>
      </header>

      <Card>
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Daily LLM budget</h2>
          {budget.exceeded && (
            <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
              exhausted
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Hard cap on LLM spend per UTC day across this organization. New agent steps are refused
          when the cap is reached. Leave empty to remove the cap.
        </p>
        <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Today's spend</div>
            <div className="font-mono tabular-nums">${budget.todaysSpendUsd.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Cap</div>
            <div className="font-mono tabular-nums">
              {budget.dailyBudgetUsd === null ? '—' : `$${budget.dailyBudgetUsd.toFixed(2)}`}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Remaining</div>
            <div className="font-mono tabular-nums">
              {budget.remainingUsd === null ? '—' : `$${budget.remainingUsd.toFixed(2)}`}
            </div>
          </div>
        </div>
        {canEdit ? (
          <form action={setBudgetAction} className="mt-4 flex items-end gap-2">
            <input type="hidden" name="slug" value={slug} />
            <label className="flex-1 text-sm">
              <span className="block text-zinc-600 dark:text-zinc-400">Daily cap (USD)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                name="dailyBudgetUsd"
                defaultValue={budget.dailyBudgetUsd ?? ''}
                placeholder="(no cap)"
                className="mt-1 w-full rounded border px-2 py-1 dark:bg-zinc-900 dark:border-zinc-700"
              />
            </label>
            <Button variant="primary" type="submit">Save</Button>
          </form>
        ) : (
          <p className="mt-4 text-xs text-zinc-500">Only admins can change this.</p>
        )}
      </Card>

      <Card>
        <h2 className="font-medium">Members</h2>
        <ul className="mt-2 space-y-1 text-sm">
          {members.items.map((m: any) => (
            <li key={m.id} className="flex items-baseline justify-between">
              <span>{m.user.email}</span>
              <span className="text-zinc-500">{m.role}</span>
            </li>
          ))}
        </ul>
      </Card>
      <LlmProvidersCard
        providers={providers.items as any}
        canEdit={canEdit}
        onCreate={async (input) => {
          'use server';
          try {
            await api(`/v1/orgs/${slug}/llm/providers`, {
              method: 'POST',
              body: JSON.stringify({
                kind: input.kind,
                label: input.label,
                apiKey: input.apiKey || undefined,
                endpoint: input.endpoint || undefined,
                capabilityOverrides: input.models.length > 0 ? { models: input.models } : undefined,
              }),
              session: await requireSession(),
            });
            revalidatePath(`/orgs/${slug}/settings`);
            return { ok: true };
          } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
          }
        }}
        onUpdate={async (id, input) => {
          'use server';
          try {
            await api(`/v1/orgs/${slug}/llm/providers/${id}`, {
              method: 'PATCH',
              body: JSON.stringify({
                label: input.label,
                endpoint: input.endpoint,
                apiKey: input.apiKey,
                capabilityOverrides:
                  input.models === null ? null : { models: input.models },
              }),
              session: await requireSession(),
            });
            revalidatePath(`/orgs/${slug}/settings`);
            return { ok: true };
          } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
          }
        }}
        onDelete={async (id) => {
          'use server';
          try {
            await api(`/v1/orgs/${slug}/llm/providers/${id}`, {
              method: 'DELETE',
              session: await requireSession(),
            });
            revalidatePath(`/orgs/${slug}/settings`);
            return { ok: true };
          } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
          }
        }}
      />
    </main>
  );
}
