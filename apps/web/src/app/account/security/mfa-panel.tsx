'use client';

import { useState, useTransition } from 'react';
import { Button } from '@/components/ui';
import {
  startSetup,
  verify as verifyAction,
  disable as disableAction,
  regenerateRecoveryCodes,
  challenge as challengeAction,
} from './actions';

interface Status {
  enrolled: boolean;
  enrolledAt: string | null;
  pending: boolean;
  recoveryCodesRemaining: number;
}

export function MfaPanel({ status }: { status: Status }) {
  const [, startTx] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [setupState, setSetupState] = useState<{ qrDataUrl: string; otpauthUrl: string } | null>(
    null,
  );
  const [setupCode, setSetupCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disableCode, setDisableCode] = useState('');
  const [regenCode, setRegenCode] = useState('');
  const [challengeCode, setChallengeCode] = useState('');
  const [pending, setPending] = useState(false);

  const run = <T,>(fn: () => Promise<T>, after?: (r: T) => void) => {
    setError(null);
    setPending(true);
    startTx(async () => {
      try {
        const r = await fn();
        after?.(r);
      } finally {
        setPending(false);
      }
    });
  };

  // ── Enrolled view ───────────────────────────────────────────────────────
  if (status.enrolled) {
    return (
      <div className="space-y-4">
        <div className="rounded border border-emerald-200 bg-emerald-50 p-3 text-sm dark:border-emerald-800 dark:bg-emerald-900/20">
          <div className="font-medium text-emerald-900 dark:text-emerald-200">
            MFA is enrolled
          </div>
          <div className="mt-1 text-emerald-800 dark:text-emerald-300">
            Enrolled{' '}
            {status.enrolledAt ? new Date(status.enrolledAt).toLocaleString() : '—'} ·{' '}
            {status.recoveryCodesRemaining} recovery code
            {status.recoveryCodesRemaining === 1 ? '' : 's'} remaining
          </div>
        </div>

        {recoveryCodes && (
          <RecoveryCodesPanel codes={recoveryCodes} onClose={() => setRecoveryCodes(null)} />
        )}

        <Section title="Refresh MFA challenge">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Admin and owner write actions require a TOTP challenge within the last 15 minutes.
            Use this to refresh without leaving the page.
          </p>
          <CodeForm
            placeholder="123456 or recovery code"
            value={challengeCode}
            onChange={setChallengeCode}
            disabled={pending}
            onSubmit={() =>
              run(
                () => challengeAction(challengeCode),
                (r) => {
                  if (r.ok) {
                    setChallengeCode('');
                  } else setError(r.error);
                },
              )
            }
            submitLabel="Submit code"
          />
        </Section>

        <Section title="Regenerate recovery codes">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Invalidates the existing set and issues 10 fresh single-use codes.
          </p>
          <CodeForm
            placeholder="123456"
            value={regenCode}
            onChange={setRegenCode}
            disabled={pending}
            onSubmit={() =>
              run(
                () => regenerateRecoveryCodes(regenCode),
                (r) => {
                  if (r.ok) {
                    setRegenCode('');
                    setRecoveryCodes(r.recoveryCodes);
                  } else setError(r.error);
                },
              )
            }
            submitLabel="Regenerate"
          />
        </Section>

        <Section title="Disable MFA" tone="danger">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Removes the secret and all recovery codes. Admin and owner write actions will be
            blocked until you re-enroll.
          </p>
          <CodeForm
            placeholder="123456"
            value={disableCode}
            onChange={setDisableCode}
            disabled={pending}
            onSubmit={() =>
              run(
                () => disableAction(disableCode),
                (r) => {
                  if (r.ok) setDisableCode('');
                  else setError(r.error);
                },
              )
            }
            submitLabel="Disable MFA"
            danger
          />
        </Section>

        {error && <ErrorRow message={error} />}
      </div>
    );
  }

  // ── Pending verification view ───────────────────────────────────────────
  if (setupState || status.pending) {
    return (
      <div className="space-y-4">
        {setupState && (
          <div className="space-y-3 rounded border border-zinc-200 p-3 dark:border-zinc-800">
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              Scan this QR code with your authenticator app, then enter the 6-digit code below.
            </p>
            <img
              src={setupState.qrDataUrl}
              alt="MFA QR code"
              className="rounded bg-white p-2"
              width={240}
              height={240}
            />
            <details>
              <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
                Can't scan? Show otpauth URL
              </summary>
              <pre className="mt-2 overflow-x-auto rounded bg-zinc-50 p-2 text-[11px] text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
                {setupState.otpauthUrl}
              </pre>
            </details>
          </div>
        )}

        {recoveryCodes ? (
          <RecoveryCodesPanel codes={recoveryCodes} onClose={() => setRecoveryCodes(null)} />
        ) : (
          <CodeForm
            placeholder="123456"
            value={setupCode}
            onChange={setSetupCode}
            disabled={pending}
            onSubmit={() =>
              run(
                () => verifyAction(setupCode),
                (r) => {
                  if (r.ok) {
                    setSetupCode('');
                    setRecoveryCodes(r.recoveryCodes);
                    setSetupState(null);
                  } else setError(r.error);
                },
              )
            }
            submitLabel="Verify and enable"
          />
        )}

        {error && <ErrorRow message={error} />}
      </div>
    );
  }

  // ── Not enrolled view ───────────────────────────────────────────────────
  return (
    <div className="space-y-3">
      <p className="text-sm text-zinc-600 dark:text-zinc-400">
        Two-factor authentication uses a time-based code from your authenticator app
        (1Password, Authy, Google Authenticator, etc.) plus 10 single-use recovery codes
        as fallback. Required for admin and owner roles.
      </p>
      <Button
        variant="primary"
        disabled={pending}
        onClick={() =>
          run(
            () => startSetup(),
            (r) => {
              if (r.ok) setSetupState({ qrDataUrl: r.qrDataUrl, otpauthUrl: r.otpauthUrl });
              else setError(r.error);
            },
          )
        }
      >
        Set up MFA
      </Button>
      {error && <ErrorRow message={error} />}
    </div>
  );
}

function Section({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: 'danger';
}) {
  return (
    <section
      className={
        'space-y-2 rounded border p-3 ' +
        (tone === 'danger'
          ? 'border-rose-200 dark:border-rose-900/60'
          : 'border-zinc-200 dark:border-zinc-800')
      }
    >
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function CodeForm({
  placeholder,
  value,
  onChange,
  disabled,
  onSubmit,
  submitLabel,
  danger,
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  onSubmit: () => void;
  submitLabel: string;
  danger?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-sm">
        <span className="block text-zinc-600 dark:text-zinc-400">Code</span>
        <input
          className="mt-1 w-44 rounded border px-2 py-1 font-mono dark:bg-zinc-900 dark:border-zinc-700 disabled:opacity-60"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="one-time-code"
          inputMode="numeric"
          disabled={disabled}
        />
      </label>
      <Button
        variant={danger ? 'secondary' : 'primary'}
        disabled={disabled || value.trim().length === 0}
        onClick={onSubmit}
      >
        {submitLabel}
      </Button>
    </div>
  );
}

function RecoveryCodesPanel({
  codes,
  onClose,
}: {
  codes: string[];
  onClose: () => void;
}) {
  return (
    <div className="space-y-2 rounded border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-900/20">
      <div className="font-medium text-amber-900 dark:text-amber-200">
        Save these recovery codes
      </div>
      <p className="text-amber-800 dark:text-amber-300">
        Each code works once. Store them somewhere safe — they will not be shown again. Use them
        if you lose access to your authenticator.
      </p>
      <ul className="grid grid-cols-2 gap-1 font-mono text-xs">
        {codes.map((c) => (
          <li
            key={c}
            className="select-all rounded bg-white px-2 py-1 text-zinc-800 dark:bg-zinc-900 dark:text-zinc-200"
          >
            {c}
          </li>
        ))}
      </ul>
      <Button variant="secondary" onClick={onClose}>
        I've saved them
      </Button>
    </div>
  );
}

function ErrorRow({ message }: { message: string }) {
  return (
    <div className="rounded bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-900/20 dark:text-rose-300">
      {message}
    </div>
  );
}
