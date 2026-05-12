import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import { Card, Button, LinkButton } from '@/components/ui';
import { LlmProvidersCard } from '@/components/llm-providers-card';
import { LlmProfilesCard } from '@/components/llm-profiles-card';
import { MfaRequiredCallout } from '@/components/mfa-required-callout';
import { OrgGeneralForm } from './org-general-form';

interface BudgetInfo {
  dailyBudgetUsd: number | null;
  todaysSpendUsd: number;
  remainingUsd: number | null;
  exceeded: boolean;
}

interface SpendCapInfo {
  monthlySpendCapUsd: number | null;
  monthToDateUsd: number;
  trailing7DayAvgUsd: number;
  projectedMonthEndUsd: number;
  daysToCapExceedance: number | null;
  projectionExceedsCap: boolean;
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

async function setSpendCapAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const raw = String(formData.get('monthlySpendCapUsd') ?? '').trim();
  const parsed = raw === '' ? null : Number(raw);
  if (parsed !== null && (!Number.isFinite(parsed) || parsed < 0)) return;
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/spend-cap`, {
    method: 'PATCH',
    body: JSON.stringify({ monthlySpendCapUsd: parsed }),
    session,
  });
  revalidatePath(`/orgs/${slug}/settings`);
}

async function setTelemetryAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const enabled = formData.get('enabled') === 'on';
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/telemetry`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
    session,
  });
  revalidatePath(`/orgs/${slug}/settings`);
}

async function setEvalsAction(formData: FormData) {
  'use server';
  const slug = String(formData.get('slug') ?? '');
  const enabled = formData.get('enabled') === 'on';
  const session = await requireSession();
  await api(`/v1/orgs/${slug}/evals/settings`, {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
    session,
  });
  revalidatePath(`/orgs/${slug}/settings`);
}

export default async function OrgSettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const session = await requireSession();
  const [
    org,
    members,
    providers,
    profiles,
    budget,
    spendCap,
    canEdit,
    mfaStatus,
    telemetry,
    telemetryRecent,
    evals,
  ] = await Promise.all([
    api<any>(`/v1/orgs/${slug}`, { session }),
    api<{ items: any[] }>(`/v1/orgs/${slug}/members`, { session }),
    api<{ items: any[] }>(`/v1/orgs/${slug}/llm/providers`, { session }),
    api<{ items: any[] }>(`/v1/orgs/${slug}/llm/profiles`, { session }),
    api<BudgetInfo>(`/v1/orgs/${slug}/budget`, { session }),
    api<SpendCapInfo>(`/v1/orgs/${slug}/spend-cap`, { session }),
    hasRole(slug, session, 'admin'),
    api<{ enrolled: boolean }>(`/v1/me/mfa`, { session }).catch(() => ({ enrolled: false })),
    api<{ enabled: boolean; installId: string | null }>(`/v1/orgs/${slug}/telemetry`, { session }).catch(
      () => ({ enabled: false, installId: null }),
    ),
    api<{ items: Array<{ type: string; occurredAt: string; installId: string; version: string }> }>(
      `/v1/orgs/${slug}/telemetry/recent`,
      { session },
    ).catch(() => ({ items: [] })),
    api<{ enabled: boolean; lastRanAt: string | null }>(
      `/v1/orgs/${slug}/evals/settings`,
      { session },
    ).catch(() => ({ enabled: false, lastRanAt: null })),
  ]);
  const monthlyPct =
    spendCap.monthlySpendCapUsd && spendCap.monthlySpendCapUsd > 0
      ? Math.min(100, (spendCap.monthToDateUsd / spendCap.monthlySpendCapUsd) * 100)
      : 0;
  // MFA is recommended for admin/owner accounts but not enforced (see
  // RoleGuard). Surface a passive nudge for admins who haven't enrolled.
  const showMfaNudge = canEdit && !mfaStatus.enrolled;

  return (
    <main className="mx-auto max-w-3xl space-y-4 p-6">
      <header>
        <h1 className="text-xl font-semibold">Settings</h1>
        <p className="text-sm text-zinc-500">Org &nbsp;<code>{org.slug}</code></p>
      </header>

      {showMfaNudge && <MfaRequiredCallout />}

      <Card>
        <h2 className="font-medium">General</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Display name and URL slug. Changing the slug rewrites every URL under
          this org — bookmarks and any tooling that references{' '}
          <code>/orgs/{org.slug}/…</code> will need to be updated.
        </p>
        <div className="mt-3">
          <OrgGeneralForm
            initialName={org.name}
            initialSlug={org.slug}
            canEdit={canEdit}
            onSave={async (input) => {
              'use server';
              try {
                const updated = await api<{ name: string; slug: string }>(
                  `/v1/orgs/${slug}/`,
                  {
                    method: 'PATCH',
                    body: JSON.stringify(input),
                    session: await requireSession(),
                  },
                );
                revalidatePath(`/orgs/${slug}/settings`);
                if (updated.slug !== slug) {
                  // Slug changed — caller's URL is now stale. Hop to the
                  // new path so subsequent actions on this page hit the
                  // right tenant.
                  redirect(`/orgs/${updated.slug}/settings?renamed=1`);
                }
                return { ok: true, newSlug: updated.slug };
              } catch (e: any) {
                return { ok: false, error: String(e?.message ?? e) };
              }
            }}
          />
        </div>
      </Card>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Guardrails
          </h2>
          <a
            href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/08-monthly-spend-cap.md"
            target="_blank"
            rel="noreferrer"
            className="text-xs text-zinc-500 underline decoration-dotted hover:text-zinc-700 dark:hover:text-zinc-300"
          >
            Guardrails overview →
          </a>
        </div>
        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          Cost ceilings and spend forecasting that constrain how much the agent loop can bill
          against your LLM providers. Project-level guardrails (dry-run, blast-radius, risk-score)
          live under each project&apos;s settings.
        </p>
      </section>

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
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Monthly LLM spend cap</h2>
          {spendCap.exceeded && (
            <span className="rounded bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/40 dark:text-red-300">
              exhausted
            </span>
          )}
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Hard ceiling on LLM spend per calendar month (UTC) across this organization. New agent
          steps are refused with reason <code>cap_exceeded</code> when the cap is reached, so a
          runaway loop can&apos;t burn past it. Leave empty to remove the cap.{' '}
          <a
            href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/08-monthly-spend-cap.md"
            className="text-zinc-700 underline decoration-dotted hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
          >
            Learn more
          </a>
        </p>
        <div className="mt-3 grid grid-cols-3 gap-3 text-sm">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Month-to-date</div>
            <div className="font-mono tabular-nums">${spendCap.monthToDateUsd.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Cap</div>
            <div className="font-mono tabular-nums">
              {spendCap.monthlySpendCapUsd === null ? '—' : `$${spendCap.monthlySpendCapUsd.toFixed(2)}`}
            </div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">Remaining</div>
            <div className="font-mono tabular-nums">
              {spendCap.remainingUsd === null ? '—' : `$${spendCap.remainingUsd.toFixed(2)}`}
            </div>
          </div>
        </div>
        {spendCap.monthlySpendCapUsd !== null && (
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
            <div
              className={
                'h-full transition-[width] ' +
                (monthlyPct >= 100
                  ? 'bg-red-600'
                  : monthlyPct >= 80
                    ? 'bg-amber-500'
                    : 'bg-emerald-500')
              }
              style={{ width: `${monthlyPct}%` }}
              aria-label={`${monthlyPct.toFixed(0)}% of cap used`}
            />
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-3 border-t pt-3 text-sm dark:border-zinc-800">
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">
              Trailing 7-day avg / day
            </div>
            <div className="font-mono tabular-nums">${spendCap.trailing7DayAvgUsd.toFixed(2)}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-wide text-zinc-500">
              Projected month-end
            </div>
            <div className="font-mono tabular-nums">${spendCap.projectedMonthEndUsd.toFixed(2)}</div>
          </div>
        </div>
        {spendCap.projectionExceedsCap && spendCap.monthlySpendCapUsd !== null && (
          <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700/40 dark:bg-amber-950/30 dark:text-amber-200">
            <strong>On track to exceed the cap by ~$
            {Math.max(0, spendCap.projectedMonthEndUsd - spendCap.monthlySpendCapUsd).toFixed(2)}.
            </strong>{' '}
            At the current 7-day pace
            {spendCap.daysToCapExceedance != null && (
              <> you&apos;ll hit the cap around day {spendCap.daysToCapExceedance} of the month.</>
            )}
            {' '}Raise the cap or tighten the per-step budget before runs start refusing.
          </div>
        )}
        {canEdit ? (
          <form action={setSpendCapAction} className="mt-4 flex items-end gap-2">
            <input type="hidden" name="slug" value={slug} />
            <label className="flex-1 text-sm">
              <span className="block text-zinc-600 dark:text-zinc-400">Monthly cap (USD)</span>
              <input
                type="number"
                step="0.01"
                min="0"
                name="monthlySpendCapUsd"
                defaultValue={spendCap.monthlySpendCapUsd ?? ''}
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
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Nightly evals</h2>
          <LinkButton href={`/orgs/${slug}/evals`} variant="secondary">
            View dashboard →
          </LinkButton>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Auto-runs the eval fixture corpus once per day against the org&apos;s default LLM
          profile. Each tick costs a few dollars at typical profile pricing — off by default. Pair
          with a tight monthly spend cap while you&apos;re tuning thresholds.{' '}
          <a
            href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/15-evals.md"
            target="_blank"
            rel="noreferrer"
            className="text-zinc-700 underline decoration-dotted hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-zinc-100"
          >
            Eval cookbook →
          </a>
        </p>
        {evals.lastRanAt && (
          <p className="mt-2 text-xs text-zinc-500">
            Last cron run: {new Date(evals.lastRanAt).toLocaleString()}
          </p>
        )}
        {canEdit ? (
          <form action={setEvalsAction} className="mt-3 flex items-center gap-2">
            <input type="hidden" name="slug" value={slug} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={evals.enabled} />
              <span>Run evals nightly</span>
            </label>
            <Button variant="primary" type="submit">
              Save
            </Button>
          </form>
        ) : (
          <p className="mt-3 text-xs text-zinc-500">Only admins can change this.</p>
        )}
      </Card>

      <Card>
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Outbound webhooks</h2>
          <LinkButton href={`/orgs/${slug}/settings/webhooks`} variant="secondary">
            Manage →
          </LinkButton>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          POST run/changeset events to your endpoints. Each delivery is HMAC-signed.
        </p>
      </Card>

      <Card>
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">API keys</h2>
          <LinkButton href={`/orgs/${slug}/settings/api-keys`} variant="secondary">
            Manage →
          </LinkButton>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Programmatic <code>mc_live_…</code> tokens for the TS/Python SDKs and CI tooling.
        </p>
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
        onTest={async (id) => {
          'use server';
          try {
            const r = await api<
              | { ok: true; modelId: string; latencyMs: number; reply: string }
              | { ok: false; error: string }
            >(`/v1/orgs/${slug}/llm/providers/${id}/test`, {
              method: 'POST',
              body: '{}',
              session: await requireSession(),
            });
            return r;
          } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
          }
        }}
        onProbe={async (id) => {
          'use server';
          try {
            const r = await api<
              { ok: true; models: string[] } | { ok: false; error: string }
            >(`/v1/orgs/${slug}/llm/providers/${id}/probe`, {
              method: 'POST',
              body: '{}',
              session: await requireSession(),
            });
            revalidatePath(`/orgs/${slug}/settings`);
            return r;
          } catch (e: any) {
            return { ok: false, error: String(e?.message ?? e) };
          }
        }}
      />

      <LlmProfilesCard
        profiles={profiles.items as any}
        availableRefs={(providers.items as Array<{ kind?: string; capabilityOverrides?: { models?: string[] } }>)
          .flatMap((p) =>
            (p.capabilityOverrides?.models ?? []).map((m) => `${p.kind ?? ''}/${m}`),
          )
          .filter((r) => r.includes('/') && !r.startsWith('/'))}
        canEdit={canEdit}
        onCreate={async (input) => {
          'use server';
          try {
            await api(`/v1/orgs/${slug}/llm/profiles`, {
              method: 'POST',
              body: JSON.stringify(input),
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
            await api(`/v1/orgs/${slug}/llm/profiles/${id}`, {
              method: 'PATCH',
              body: JSON.stringify(input),
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
            await api(`/v1/orgs/${slug}/llm/profiles/${id}`, {
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

      <Card>
        <div className="flex items-baseline justify-between">
          <h2 className="font-medium">Anonymous usage telemetry</h2>
          <span
            className={
              telemetry.enabled
                ? 'rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                : 'rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300'
            }
          >
            {telemetry.enabled ? 'on' : 'off'}
          </span>
        </div>
        <p className="mt-1 text-sm text-zinc-500">
          Helps us see whether adoption changes are working: which adapters get picked, where the
          onboarding wizard loses people, how often runs complete. Off by default. No PII, no org
          or project names, no repo content — just the documented event fields. Read the{' '}
          <a
            href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/07-telemetry.md"
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline decoration-dotted"
          >
            schema doc
          </a>{' '}
          before opting in.
        </p>
        {telemetry.enabled && telemetry.installId && (
          <p className="mt-2 font-mono text-xs text-zinc-500">
            Install id: {telemetry.installId}
          </p>
        )}
        <p className="mt-2 text-xs text-zinc-500">
          Set <code>MERGECREW_TELEMETRY_URL</code> on the API + orchestrator processes to point at
          your own receiver. With it empty (the default), no outbound HTTP is made regardless of
          this toggle. The reference receiver under{' '}
          <code>infra/telemetry/</code> is one option.
        </p>
        {telemetry.enabled && telemetryRecent.items.length > 0 && (
          <div className="mt-4">
            <div className="text-xs uppercase tracking-wide text-zinc-500">
              Recent events (this API process, last 10)
            </div>
            <ul className="mt-2 divide-y divide-zinc-200 dark:divide-zinc-800">
              {telemetryRecent.items.map((ev, i) => (
                <li key={`${ev.occurredAt}-${i}`} className="py-1.5 text-xs">
                  <span className="font-mono text-zinc-500">
                    {new Date(ev.occurredAt).toLocaleTimeString()}
                  </span>{' '}
                  <span className="font-mono">{ev.type}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-zinc-500">
              Orchestrator-emitted events (e.g. <code>run.completed</code> on success) do not appear
              here — the audit buffer is per-process. See <code>infra/telemetry/</code> output for
              the full stream.
            </p>
          </div>
        )}
        {telemetry.enabled && telemetryRecent.items.length === 0 && (
          <p className="mt-3 text-xs text-zinc-500">
            No telemetry events recorded since the API process started. Trigger an action (create a
            project, connect a repo, …) and refresh this page.
          </p>
        )}
        {canEdit ? (
          <form action={setTelemetryAction} className="mt-4 flex items-center gap-2">
            <input type="hidden" name="slug" value={slug} />
            <Button variant={telemetry.enabled ? 'secondary' : 'primary'} type="submit" name="enabled" value={telemetry.enabled ? 'off' : 'on'}>
              {telemetry.enabled ? 'Turn off telemetry' : 'Opt in to telemetry'}
            </Button>
          </form>
        ) : (
          <p className="mt-4 text-xs text-zinc-500">Only admins can change this.</p>
        )}
      </Card>
    </main>
  );
}
