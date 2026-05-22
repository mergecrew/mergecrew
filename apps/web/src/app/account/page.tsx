import Link from 'next/link';
import { api } from '@/lib/api';
import { requireSession } from '@/lib/session';
import { TopBar } from '@/components/shell/topbar';
import { UserMenu } from '@/components/user-menu';
import { SettingsLayout, Section } from '@/components/shell/settings-layout';
import { Card, FieldRow, Input, Label, PageHead, RolePill } from '@/components/ui';
import { MfaPanel } from './security/mfa-panel';

interface MfaStatus {
  enrolled: boolean;
  enrolledAt: string | null;
  pending: boolean;
  recoveryCodesRemaining: number;
}

type Org = { slug: string; name: string; role?: string; mtdSpendUsd?: number };

const NAV = [
  {
    label: 'Identity',
    items: [
      { id: 'profile', label: 'Profile' },
      { id: 'sign-in', label: 'Sign-in methods' },
      { id: 'tokens', label: 'Personal access tokens' },
    ],
  },
  {
    label: 'Notifications',
    items: [{ id: 'notifications', label: 'Notifications' }],
  },
  {
    label: 'Security',
    items: [
      { id: 'two-factor', label: 'Two-factor + sessions' },
      { id: 'audit-log', label: 'Account audit log' },
    ],
  },
  {
    label: 'Preferences',
    items: [
      { id: 'prefs', label: 'Display' },
      { id: 'orgs', label: 'Organisations' },
    ],
  },
  {
    label: 'Danger',
    items: [{ id: 'danger', label: 'Danger zone' }],
  },
];

export default async function AccountSettingsPage() {
  const session = await requireSession();

  const [mfa, orgsRes] = await Promise.all([
    api<MfaStatus>('/v1/me/mfa', { session }).catch(
      () => ({ enrolled: false, enrolledAt: null, pending: false, recoveryCodesRemaining: 0 }) as MfaStatus,
    ),
    api<{ items: Org[] }>('/v1/orgs', { session }).catch(() => ({ items: [] as Org[] })),
  ]);

  let pendingSetup: { qrDataUrl: string; otpauthUrl: string } | null = null;
  if (mfa.pending && !mfa.enrolled) {
    try {
      const r = await api<{ otpauthUrl: string }>('/v1/me/mfa/setup', {
        method: 'POST',
        body: JSON.stringify({}),
        session,
      });
      const QRCode = (await import('qrcode')).default;
      const qrDataUrl = await QRCode.toDataURL(r.otpauthUrl, { margin: 1, width: 240 });
      pendingSetup = { otpauthUrl: r.otpauthUrl, qrDataUrl };
    } catch {
      /* fall back to verify form without QR */
    }
  }

  const firstOrg = orgsRes.items[0]?.slug;
  const initials = (session.name ?? session.email)
    .split(/\s+/)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('')
    .slice(0, 2);

  return (
    <div className="min-h-screen bg-bg text-ink">
      <TopBar
        orgSlug={firstOrg ?? 'mergecrew'}
        userMenu={<UserMenu currentOrgSlug={firstOrg} />}
      />
      <main className="mx-auto max-w-[1280px] px-4 py-5 sm:px-9 sm:py-7">
        <PageHead
          crumb={[{ label: 'Account' }]}
          title="Account"
          meta={
            <span className="font-mono text-[12.5px] text-muted">
              {session.email} · {orgsRes.items.length} org
              {orgsRes.items.length === 1 ? '' : 's'}
            </span>
          }
        />

        <SettingsLayout nav={NAV}>
          <Section
            id="profile"
            anchor="01 · PROFILE"
            title="Profile"
            desc="How you appear to crew members and audit logs."
          >
            <Card className="p-6">
              <div className="mb-6 flex items-center gap-4">
                <div className="flex h-[56px] w-[56px] items-center justify-center bg-gradient-to-br from-accent to-accent-deep text-[18px] font-semibold text-paper">
                  {initials}
                </div>
                <div>
                  <div className="text-[16px] font-medium tracking-[-0.005em]">
                    {session.name ?? session.email}
                  </div>
                  <div className="font-mono text-[12px] text-muted">{session.email}</div>
                </div>
              </div>
              <FieldRow label="Display name" help="Visible on activity rows and run logs.">
                <Input defaultValue={session.name ?? ''} placeholder="Add your name" disabled />
              </FieldRow>
              <FieldRow label="Email" help="Verified via your sign-in provider — read-only.">
                <Input defaultValue={session.email} disabled mono />
              </FieldRow>
              <FieldRow label="Default org" help="The org you land in after sign-in.">
                <Input defaultValue={firstOrg ?? ''} disabled mono />
              </FieldRow>
              <p className="mt-4 text-[12px] text-muted">
                Editable profile fields are coming. For now changes happen via your sign-in
                provider.
              </p>
            </Card>
          </Section>

          <Section
            id="sign-in"
            anchor="02 · SIGN-IN"
            title="Sign-in methods"
            desc="OAuth providers and magic-link addresses linked to this account."
          >
            <Card className="p-5">
              <ul className="m-0 list-none p-0">
                <Method
                  glyph="G"
                  name="GitHub"
                  desc="OAuth · org-scoped"
                  status="linked"
                />
                <Method
                  glyph="g"
                  name="Google"
                  desc="OAuth · workspace"
                  status="not connected"
                />
                <Method
                  glyph="M"
                  name="Magic link"
                  desc={session.email}
                  status="active"
                  last
                />
              </ul>
              <p className="mt-4 text-[12px] text-muted">
                Unlinking a provider is handled per-OAuth — visit the provider&apos;s connected-apps
                page.
              </p>
            </Card>
          </Section>

          <Section
            id="tokens"
            anchor="03 · TOKENS"
            title="Personal access tokens"
            desc="Programmatic access. Scopes are checked at the API boundary."
          >
            <Card className="p-5">
              <p className="m-0 text-[13.5px] text-ink-2">
                PAT management lives on the org settings page today — visit{' '}
                <Link
                  href={firstOrg ? `/orgs/${firstOrg}/settings/api-keys` : '#'}
                  className="text-accent underline-offset-[3px] hover:underline"
                >
                  /orgs/{firstOrg}/settings/api-keys →
                </Link>
              </p>
            </Card>
          </Section>

          <Section
            id="notifications"
            anchor="04 · NOTIFICATIONS"
            title="Notifications"
            desc="Per-channel toggles for digest dispatch, gate reminders, and pause events."
          >
            <Card className="p-5">
              <p className="m-0 text-[13.5px] text-ink-2">
                Per-user notification preferences are not yet exposed. Project-level digest
                delivery is configured in{' '}
                <span className="font-mono text-[12.5px] text-ink">
                  Project settings → Digest delivery
                </span>
                .
              </p>
            </Card>
          </Section>

          <Section
            id="two-factor"
            anchor="05 · TWO-FACTOR"
            title="Two-factor + sessions"
            desc="TOTP authenticator, recovery codes, and active sessions."
          >
            <Card className="p-5">
              <MfaPanel status={mfa} pendingSetup={pendingSetup} />
            </Card>
          </Section>

          <Section
            id="audit-log"
            anchor="06 · AUDIT"
            title="Account audit log"
            desc="Sign-ins, token issuance, MFA changes — read-only."
          >
            <Card className="p-5">
              <p className="m-0 text-[13.5px] text-ink-2">
                Per-user audit logs are not yet exposed. Org-wide audit lives under{' '}
                <Link
                  href={firstOrg ? `/orgs/${firstOrg}/activity` : '#'}
                  className="text-accent underline-offset-[3px] hover:underline"
                >
                  Activity →
                </Link>
              </p>
            </Card>
          </Section>

          <Section
            id="prefs"
            anchor="07 · DISPLAY"
            title="Display"
            desc="Density and visual preferences. These persist via the existing DensityToggle on the run-detail page."
          >
            <Card className="p-5">
              <p className="m-0 text-[13.5px] text-ink-2">
                Density and theme controls are reachable from the run-detail page. A unified
                preferences pane lands in a later release.
              </p>
            </Card>
          </Section>

          <Section
            id="orgs"
            anchor="08 · ORGANISATIONS"
            title="Organisations"
            desc="Workspaces this account belongs to."
          >
            <Card>
              {orgsRes.items.length === 0 ? (
                <div className="p-5 text-[13px] text-muted">No org memberships yet.</div>
              ) : (
                <ul className="m-0 list-none p-0">
                  {orgsRes.items.map((o, i) => (
                    <li
                      key={o.slug}
                      className={
                        i < orgsRes.items.length - 1 ? 'border-b border-hair-2' : ''
                      }
                    >
                      <Link
                        href={`/orgs/${o.slug}`}
                        className="grid grid-cols-[1fr_auto_auto] items-center gap-4 px-5 py-4 text-[13px] text-ink no-underline hover:bg-paper-2"
                      >
                        <div className="min-w-0">
                          <div className="text-[14px] font-medium tracking-[-0.005em]">
                            {o.name}
                          </div>
                          <div className="font-mono text-[11.5px] text-muted">/{o.slug}</div>
                        </div>
                        {o.mtdSpendUsd != null && (
                          <span className="font-mono text-[11.5px] text-muted">
                            MTD ${o.mtdSpendUsd.toFixed(2)}
                          </span>
                        )}
                        {o.role && (
                          <RolePill
                            role={(o.role as 'owner' | 'admin' | 'reviewer' | 'viewer') ?? 'member'}
                          />
                        )}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </Section>

          <Section
            id="danger"
            anchor="09 · DANGER"
            title="Danger zone"
            desc="Irreversible actions. Account deletion has a 24-hour cooldown."
          >
            <Card className="border-energy bg-energy-soft p-5">
              <p className="m-0 text-[13.5px] text-energy-deep">
                Self-serve account deletion is not yet exposed. Contact your org owner or open an
                issue at{' '}
                <a
                  href="https://github.com/mergecrew/mergecrew/issues"
                  className="underline underline-offset-[3px]"
                >
                  github.com/mergecrew/mergecrew/issues
                </a>{' '}
                to request manual removal.
              </p>
            </Card>
          </Section>
        </SettingsLayout>
      </main>
    </div>
  );
}

function Method({
  glyph,
  name,
  desc,
  status,
  last,
}: {
  glyph: string;
  name: string;
  desc: string;
  status: string;
  last?: boolean;
}) {
  return (
    <li
      className={`grid grid-cols-[40px_1fr_auto] items-center gap-4 py-3 ${
        last ? '' : 'border-b border-hair-2'
      }`}
    >
      <span className="flex h-[32px] w-[32px] items-center justify-center bg-ink font-mono text-[14px] font-bold text-paper">
        {glyph}
      </span>
      <div>
        <div className="text-[14px] font-medium">{name}</div>
        <div className="font-mono text-[11.5px] text-muted">{desc}</div>
      </div>
      <span className="font-mono text-[11px] uppercase tracking-[0.06em] text-muted">
        {status}
      </span>
    </li>
  );
}
