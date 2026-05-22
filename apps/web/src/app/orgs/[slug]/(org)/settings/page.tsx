import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { hasRole } from '@/lib/role';
import {
  Card,
  Button,
  LinkButton,
  PageHead,
  Label,
  StatBadge,
  RolePill,
  Stat,
} from '@/components/ui';
import { SettingsLayout, Section } from '@/components/shell/settings-layout';
import { LlmProvidersCard } from '@/components/llm-providers-card';
import { LlmProfilesCard } from '@/components/llm-profiles-card';
import { MfaRequiredCallout } from '@/components/mfa-required-callout';
import { OrgGeneralForm } from './org-general-form';
import { MembersSection } from './members-section';

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
    auditLog,
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
    api<{
      items: Array<{
        id: string;
        action: string;
        occurredAt: string;
        target: any;
        metadata: any;
        actorUserId: string | null;
        actor: { id: string; email: string; name: string | null } | null;
      }>;
    }>(`/v1/orgs/${slug}/audit-log?limit=50`, { session }).catch(() => ({ items: [] })),
  ]);
  const monthlyPct =
    spendCap.monthlySpendCapUsd && spendCap.monthlySpendCapUsd > 0
      ? Math.min(100, (spendCap.monthToDateUsd / spendCap.monthlySpendCapUsd) * 100)
      : 0;
  // MFA is recommended for admin/owner accounts but not enforced (see
  // RoleGuard). Surface a passive nudge for admins who haven't enrolled.
  const showMfaNudge = canEdit && !mfaStatus.enrolled;

  const NAV = [
    {
      label: 'Organisation',
      items: [
        { id: 'general', label: 'General' },
        { id: 'members', label: 'Members' },
      ],
    },
    {
      label: 'LLM',
      items: [
        { id: 'providers', label: 'Providers' },
        { id: 'profiles', label: 'Profiles' },
      ],
    },
    {
      label: 'Budgets',
      items: [
        { id: 'daily-budget', label: 'Daily budget' },
        { id: 'monthly-cap', label: 'Monthly spend cap' },
      ],
    },
    {
      label: 'Operations',
      items: [
        { id: 'evals', label: 'Nightly evals' },
        { id: 'webhooks', label: 'Outbound webhooks' },
        { id: 'api-keys', label: 'API keys' },
        { id: 'audit-log', label: 'Audit log' },
      ],
    },
    {
      label: 'Privacy',
      items: [{ id: 'telemetry', label: 'Anonymous telemetry' }],
    },
    {
      label: 'Danger',
      items: [{ id: 'danger', label: 'Danger zone' }],
    },
  ];

  return (
    <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
      <PageHead
        crumb={[
          { label: org.slug, href: `/orgs/${org.slug}` },
          { label: 'Org settings' },
        ]}
        title="Org settings"
        meta={
          <span className="font-mono text-[12.5px] text-muted">
            Tenant <b className="text-ink">{org.slug}</b> · {members.items.length} member
            {members.items.length === 1 ? '' : 's'} · self-host (free)
          </span>
        }
      />

      {showMfaNudge && (
        <div className="mb-6">
          <MfaRequiredCallout />
        </div>
      )}

      <SettingsLayout nav={NAV}>
        <Section
          id="general"
          anchor="ORG · 001"
          title="General"
          desc={
            <>
              Display name and URL slug. Changing the slug rewrites every URL under this org —
              bookmarks and any tooling that references{' '}
              <code className="font-mono text-[12px] text-ink">/orgs/{org.slug}/…</code> will need
              to be updated.
            </>
          }
        >
          <Card className="p-5">
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
                    redirect(`/orgs/${updated.slug}/settings?renamed=1`);
                  }
                  return { ok: true, newSlug: updated.slug };
                } catch (e: any) {
                  return { ok: false, error: String(e?.message ?? e) };
                }
              }}
            />
          </Card>
        </Section>

        <Section
          id="members"
          anchor="ORG · 002"
          title="Members"
          desc="Org-level membership. Each project then has its own member subset and roles. Invite an existing Mergecrew user by email; pending invitations for new signups are tracked separately."
        >
          <MembersSection
            members={members.items as any}
            canEdit={canEdit}
            currentUserId={session.userId ?? null}
            actions={{
              invite: async (input) => {
                'use server';
                try {
                  await api(`/v1/orgs/${slug}/members`, {
                    method: 'POST',
                    body: JSON.stringify(input),
                    session: await requireSession(),
                  });
                  revalidatePath(`/orgs/${slug}/settings`);
                  return { ok: true } as const;
                } catch (e: any) {
                  return { ok: false, error: String(e?.message ?? e) } as const;
                }
              },
              updateRole: async (id, role) => {
                'use server';
                try {
                  await api(`/v1/orgs/${slug}/members/${id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ role }),
                    session: await requireSession(),
                  });
                  revalidatePath(`/orgs/${slug}/settings`);
                  return { ok: true } as const;
                } catch (e: any) {
                  return { ok: false, error: String(e?.message ?? e) } as const;
                }
              },
              remove: async (id) => {
                'use server';
                try {
                  await api(`/v1/orgs/${slug}/members/${id}`, {
                    method: 'DELETE',
                    session: await requireSession(),
                  });
                  revalidatePath(`/orgs/${slug}/settings`);
                  return { ok: true } as const;
                } catch (e: any) {
                  return { ok: false, error: String(e?.message ?? e) } as const;
                }
              },
            }}
          />
        </Section>

        <Section
          id="providers"
          anchor="LLM · 003"
          title="LLM providers"
          desc="Anthropic, OpenAI, Bedrock, Ollama keys + capability overrides. Shared across every project in this org."
        >
          <div id="llm" className="scroll-mt-6">
            <Card className="p-5">
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
                        capabilityOverrides:
                          input.models.length > 0 ? { models: input.models } : undefined,
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
            </Card>
          </div>
        </Section>

        <Section
          id="profiles"
          anchor="LLM · 004"
          title="LLM profiles"
          desc="Capability → model bindings (planner / coder / reviewer / scanner) with fallover order. Profiles are how the agent loop picks which provider to bill against per step."
        >
          <Card className="p-5">
            <LlmProfilesCard
              profiles={profiles.items as any}
              availableRefs={(
                providers.items as Array<{
                  kind?: string;
                  capabilityOverrides?: { models?: string[] };
                }>
              )
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
          </Card>
        </Section>

        <Section
          id="daily-budget"
          anchor="BUDGETS · 005"
          title="Daily LLM budget"
          desc="Hard cap on LLM spend per UTC day across this organization. New agent steps are refused when the cap is reached. Leave empty to remove the cap."
        >
          <Card className="p-5">
            <div className="mb-4 flex items-baseline justify-between">
              <Label>Today</Label>
              {budget.exceeded && <StatBadge kind="warn">exhausted</StatBadge>}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="Today's spend" value={`$${budget.todaysSpendUsd.toFixed(2)}`} />
              <Stat
                label="Cap"
                value={
                  budget.dailyBudgetUsd === null
                    ? '—'
                    : `$${budget.dailyBudgetUsd.toFixed(2)}`
                }
              />
              <Stat
                label="Remaining"
                value={
                  budget.remainingUsd === null ? '—' : `$${budget.remainingUsd.toFixed(2)}`
                }
              />
            </div>
            {canEdit ? (
              <form action={setBudgetAction} className="mt-5 flex items-end gap-3">
                <input type="hidden" name="slug" value={slug} />
                <label className="flex-1 text-[13px]">
                  <span className="block font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                    Daily cap (USD)
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="dailyBudgetUsd"
                    defaultValue={budget.dailyBudgetUsd ?? ''}
                    placeholder="(no cap)"
                    className="mt-2 h-[36px] w-full border border-hair bg-paper-2 px-3 font-mono text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
                  />
                </label>
                <Button variant="accent" size="sm" type="submit">
                  Save
                </Button>
              </form>
            ) : (
              <p className="mt-4 text-[12px] text-muted">Only admins can change this.</p>
            )}
          </Card>
        </Section>

        <Section
          id="monthly-cap"
          anchor="BUDGETS · 006"
          title="Monthly LLM spend cap"
          desc={
            <>
              Hard ceiling on LLM spend per calendar month (UTC) across this organization. Runs
              refuse with <code className="font-mono text-[12px] text-ink">cap_exceeded</code> when
              the cap is reached, so a runaway loop can&apos;t burn past it. Leave empty to remove
              the cap.{' '}
              <a
                href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/08-monthly-spend-cap.md"
                className="text-accent underline-offset-[3px] hover:underline"
              >
                Learn more
              </a>
            </>
          }
        >
          <Card className="p-5">
            <div className="mb-4 flex items-baseline justify-between">
              <Label>This month</Label>
              {spendCap.exceeded && <StatBadge kind="warn">exhausted</StatBadge>}
            </div>
            <div className="grid grid-cols-3 gap-3">
              <Stat label="MTD" value={`$${spendCap.monthToDateUsd.toFixed(2)}`} />
              <Stat
                label="Cap"
                value={
                  spendCap.monthlySpendCapUsd === null
                    ? '—'
                    : `$${spendCap.monthlySpendCapUsd.toFixed(2)}`
                }
              />
              <Stat
                label="Remaining"
                value={
                  spendCap.remainingUsd === null
                    ? '—'
                    : `$${spendCap.remainingUsd.toFixed(2)}`
                }
              />
            </div>
            {spendCap.monthlySpendCapUsd !== null && (
              <div className="mt-3 h-1.5 w-full overflow-hidden bg-bg-2">
                <div
                  className={
                    'h-full transition-[width] ' +
                    (monthlyPct >= 100
                      ? 'bg-energy'
                      : monthlyPct >= 80
                        ? 'bg-warn'
                        : 'bg-positive')
                  }
                  style={{ width: `${monthlyPct}%` }}
                  aria-label={`${monthlyPct.toFixed(0)}% of cap used`}
                />
              </div>
            )}
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-hair-2 pt-3">
              <Stat
                label="Trailing 7d avg / day"
                value={`$${spendCap.trailing7DayAvgUsd.toFixed(2)}`}
              />
              <Stat
                label="Projected month-end"
                value={`$${spendCap.projectedMonthEndUsd.toFixed(2)}`}
                tone={spendCap.projectionExceedsCap ? 'energy' : undefined}
              />
            </div>
            {spendCap.projectionExceedsCap && spendCap.monthlySpendCapUsd !== null && (
              <div className="mt-3 border border-warn bg-warn/20 p-3 text-[12.5px] text-ink">
                <strong>
                  On track to exceed the cap by ~$
                  {Math.max(
                    0,
                    spendCap.projectedMonthEndUsd - spendCap.monthlySpendCapUsd,
                  ).toFixed(2)}
                  .
                </strong>{' '}
                At the current 7-day pace
                {spendCap.daysToCapExceedance != null && (
                  <>
                    {' '}
                    you&apos;ll hit the cap around day {spendCap.daysToCapExceedance} of the
                    month.
                  </>
                )}{' '}
                Raise the cap or tighten the per-step budget before runs start refusing.
              </div>
            )}
            {canEdit ? (
              <form action={setSpendCapAction} className="mt-5 flex items-end gap-3">
                <input type="hidden" name="slug" value={slug} />
                <label className="flex-1 text-[13px]">
                  <span className="block font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
                    Monthly cap (USD)
                  </span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    name="monthlySpendCapUsd"
                    defaultValue={spendCap.monthlySpendCapUsd ?? ''}
                    placeholder="(no cap)"
                    className="mt-2 h-[36px] w-full border border-hair bg-paper-2 px-3 font-mono text-[13.5px] text-ink outline-none transition-[border-color,box-shadow] duration-100 focus:border-accent focus:shadow-[0_0_0_3px_var(--accent-soft)]"
                  />
                </label>
                <Button variant="accent" size="sm" type="submit">
                  Save
                </Button>
              </form>
            ) : (
              <p className="mt-4 text-[12px] text-muted">Only admins can change this.</p>
            )}
          </Card>
        </Section>

        <Section
          id="evals"
          anchor="OPS · 007"
          title="Nightly evals"
          desc={
            <>
              Auto-runs the eval fixture corpus once per day against the org&apos;s default LLM
              profile. Each tick costs a few dollars at typical profile pricing — off by default.
              Pair with a tight monthly spend cap while you&apos;re tuning thresholds.{' '}
              <a
                href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/15-evals.md"
                target="_blank"
                rel="noreferrer"
                className="text-accent underline-offset-[3px] hover:underline"
              >
                Eval cookbook →
              </a>
            </>
          }
        >
          <Card className="p-5">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <StatBadge kind={evals.enabled ? 'healthy' : 'disabled'}>
                {evals.enabled ? 'on' : 'off'}
              </StatBadge>
              <LinkButton href={`/orgs/${slug}/evals`} variant="ghost" size="sm">
                View dashboard →
              </LinkButton>
            </div>
            {evals.lastRanAt && (
              <p className="m-0 font-mono text-[11.5px] text-muted">
                Last cron run: {new Date(evals.lastRanAt).toLocaleString()}
              </p>
            )}
            {canEdit ? (
              <form action={setEvalsAction} className="mt-3 flex items-center gap-3">
                <input type="hidden" name="slug" value={slug} />
                <label className="flex items-center gap-2 text-[13.5px]">
                  <input
                    type="checkbox"
                    name="enabled"
                    defaultChecked={evals.enabled}
                    className="h-4 w-4 accent-accent"
                  />
                  <span>Run evals nightly</span>
                </label>
                <Button variant="accent" size="sm" type="submit">
                  Save
                </Button>
              </form>
            ) : (
              <p className="mt-3 text-[12px] text-muted">Only admins can change this.</p>
            )}
          </Card>
        </Section>

        <Section
          id="webhooks"
          anchor="OPS · 008"
          title="Outbound webhooks"
          desc="POST run / changeset events to your endpoints. Each delivery is HMAC-signed."
        >
          <Card className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="m-0 text-[13.5px] text-ink-2">
                Manage subscriptions, view delivery history, rotate signing secrets.
              </p>
              <LinkButton href={`/orgs/${slug}/settings/webhooks`} variant="ghost" size="sm">
                Manage →
              </LinkButton>
            </div>
          </Card>
        </Section>

        <Section
          id="api-keys"
          anchor="OPS · 009"
          title="API keys"
          desc={
            <>
              Programmatic{' '}
              <code className="font-mono text-[12px] text-ink">mc_live_…</code> tokens for the TS /
              Python SDKs and CI tooling.
            </>
          }
        >
          <Card className="p-5">
            <div className="flex items-baseline justify-between gap-3">
              <p className="m-0 text-[13.5px] text-ink-2">
                Rotate, revoke, and scope keys by capability.
              </p>
              <LinkButton href={`/orgs/${slug}/settings/api-keys`} variant="ghost" size="sm">
                Manage →
              </LinkButton>
            </div>
          </Card>
        </Section>

        <Section
          id="audit-log"
          anchor="OPS · 010"
          title="Audit log"
          desc={
            <>
              Immutable record of admin actions in this org — invites, role changes, project
              pause / resume, telemetry opt-in. Latest 50 shown.{' '}
              <a
                href={`/api/v1/orgs/${slug}/audit-log?format=csv`}
                className="text-accent underline-offset-[3px] hover:underline"
              >
                Export CSV →
              </a>
            </>
          }
        >
          <Card>
            {auditLog.items.length === 0 ? (
              <div className="p-5 text-[13px] text-muted">
                No audit events recorded yet. Anything done from this page (or another
                admin-gated surface) lands here.
              </div>
            ) : (
              <ul className="m-0 list-none p-0">
                {auditLog.items.map((e, i) => {
                  const actorLabel =
                    e.actor?.name?.trim() || e.actor?.email || e.actorUserId || 'system';
                  return (
                    <li
                      key={e.id}
                      className={i < auditLog.items.length - 1 ? 'border-b border-hair-2' : ''}
                    >
                      <div className="grid grid-cols-1 items-baseline gap-2 px-5 py-3 text-[13px] md:grid-cols-[170px_220px_1fr] md:gap-4">
                        <span
                          className="font-mono text-[11.5px] text-muted"
                          title={new Date(e.occurredAt).toLocaleString()}
                        >
                          {new Date(e.occurredAt).toLocaleString()}
                        </span>
                        <span className="bg-accent-tint px-[8px] py-[2px] font-mono text-[10.5px] uppercase tracking-[0.06em] text-accent-deep">
                          {e.action}
                        </span>
                        <span className="min-w-0 truncate text-ink-2">
                          <b className="text-ink">{actorLabel}</b>
                          {e.target && typeof e.target === 'object' && (
                            <span className="ml-2 font-mono text-[11.5px] text-muted">
                              {summariseTarget(e.target)}
                            </span>
                          )}
                        </span>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </Section>

        <Section
          id="telemetry"
          anchor="PRIVACY · 011"
          title="Anonymous usage telemetry"
          desc={
            <>
              Helps us see whether adoption changes are working: which adapters get picked, where
              the onboarding wizard loses people, how often runs complete. Off by default. No PII,
              no org or project names, no repo content — just the documented event fields.{' '}
              <a
                href="https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/07-telemetry.md"
                target="_blank"
                rel="noopener noreferrer"
                className="text-accent underline-offset-[3px] hover:underline"
              >
                Schema doc →
              </a>
            </>
          }
        >
          <Card className="p-5">
            <div className="mb-3">
              <StatBadge kind={telemetry.enabled ? 'healthy' : 'disabled'}>
                {telemetry.enabled ? 'on' : 'off'}
              </StatBadge>
            </div>
            {telemetry.enabled && telemetry.installId && (
              <p className="m-0 font-mono text-[11.5px] text-muted">
                Install id: {telemetry.installId}
              </p>
            )}
            <p className="mt-2 text-[12px] leading-[1.55] text-muted">
              Set <code className="font-mono text-[11.5px] text-ink">MERGECREW_TELEMETRY_URL</code>{' '}
              on the API + orchestrator processes to point at your own receiver. With it empty
              (the default), no outbound HTTP is made regardless of this toggle. The reference
              receiver under <code className="font-mono text-[11.5px] text-ink">infra/telemetry/</code>{' '}
              is one option.
            </p>
            {telemetry.enabled && telemetryRecent.items.length > 0 && (
              <div className="mt-4">
                <Label className="block mb-2">Recent events (this API process, last 10)</Label>
                <ul className="m-0 divide-y divide-hair-2 border border-hair-2 p-0">
                  {telemetryRecent.items.map((ev, i) => (
                    <li key={`${ev.occurredAt}-${i}`} className="px-3 py-2 text-[12px]">
                      <span className="font-mono text-muted">
                        {new Date(ev.occurredAt).toLocaleTimeString()}
                      </span>{' '}
                      <span className="font-mono text-ink">{ev.type}</span>
                    </li>
                  ))}
                </ul>
                <p className="mt-2 text-[11.5px] text-muted">
                  Orchestrator-emitted events (e.g.{' '}
                  <code className="font-mono text-[11.5px] text-ink">run.completed</code> on
                  success) don&apos;t appear here — the audit buffer is per-process.
                </p>
              </div>
            )}
            {telemetry.enabled && telemetryRecent.items.length === 0 && (
              <p className="mt-3 text-[12px] text-muted">
                No telemetry events recorded since the API process started. Trigger an action (create
                a project, connect a repo, …) and refresh this page.
              </p>
            )}
            {canEdit ? (
              <form action={setTelemetryAction} className="mt-4">
                <input type="hidden" name="slug" value={slug} />
                <Button
                  variant={telemetry.enabled ? 'ghost' : 'accent'}
                  size="sm"
                  type="submit"
                  name="enabled"
                  value={telemetry.enabled ? 'off' : 'on'}
                >
                  {telemetry.enabled ? 'Turn off telemetry' : 'Opt in to telemetry'}
                </Button>
              </form>
            ) : (
              <p className="mt-4 text-[12px] text-muted">Only admins can change this.</p>
            )}
          </Card>
        </Section>

        <Section
          id="danger"
          anchor="ORG · 011"
          title="Danger zone"
          desc="Org-wide destructive actions. Requires owner role; the API doesn't ship self-serve transfer or delete yet — open an issue to coordinate."
        >
          <Card className="border-energy bg-energy-soft p-5">
            <div className="text-[13.5px] font-medium text-energy-deep">
              Transfer ownership / delete org
            </div>
            <p className="mt-1 text-[12.5px] text-energy-deep/80">
              These flows aren&apos;t yet self-serve. Open an issue at{' '}
              <a
                href="https://github.com/mergecrew/mergecrew/issues"
                className="underline underline-offset-[3px]"
              >
                github.com/mergecrew/mergecrew/issues
              </a>{' '}
              and an admin will help coordinate the migration.
            </p>
          </Card>
        </Section>
      </SettingsLayout>
    </main>
  );
}

// AuditLogEntry.target is a free-form JSON column. The common shape is
// `{ organizationId, projectId?, memberId?, ... }`. We surface whichever
// of the well-known keys is present, in priority order, and otherwise
// fall back to JSON.stringify on the whole object for an audit trail
// that's still legible (even if not pretty) for unknown actions.
function summariseTarget(target: any): string {
  if (!target || typeof target !== 'object') return '';
  if (typeof target.projectSlug === 'string') return `project ${target.projectSlug}`;
  if (typeof target.memberEmail === 'string') return target.memberEmail;
  if (typeof target.projectId === 'string') return `project ${String(target.projectId).slice(0, 8)}`;
  if (typeof target.membershipId === 'string')
    return `membership ${String(target.membershipId).slice(0, 8)}`;
  // Drop the redundant organizationId — every entry has it.
  const { organizationId: _drop, ...rest } = target;
  if (Object.keys(rest).length === 0) return '';
  try {
    return JSON.stringify(rest);
  } catch {
    return '';
  }
}

