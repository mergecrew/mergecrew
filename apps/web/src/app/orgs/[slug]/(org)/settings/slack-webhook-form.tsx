'use client';

import { useState, useTransition } from 'react';
import { Card } from '@/components/ui';
import {
  setSlackWebhookAction,
  clearSlackWebhookAction,
  testSlackWebhookAction,
} from './slack-webhook-actions';

export function SlackWebhookForm({
  slug,
  initial,
  canEdit,
}: {
  slug: string;
  initial: { configured: boolean; createdAt: string | null };
  canEdit: boolean;
}) {
  const [configured, setConfigured] = useState(initial.configured);
  const [createdAt, setCreatedAt] = useState(initial.createdAt);
  const [url, setUrl] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [pending, startTransition] = useTransition();

  const save = () => {
    if (!canEdit || pending) return;
    setMsg(null);
    const trimmed = url.trim();
    if (!trimmed) {
      setMsg({ kind: 'err', text: 'Paste an https://hooks.slack.com/services/… URL' });
      return;
    }
    startTransition(async () => {
      try {
        const r = await setSlackWebhookAction(slug, trimmed);
        setConfigured(true);
        setCreatedAt(r.createdAt);
        setUrl('');
        setMsg({ kind: 'ok', text: 'Saved. Webhook is wired up.' });
      } catch (e) {
        setMsg({ kind: 'err', text: (e as Error)?.message ?? 'Save failed' });
      }
    });
  };

  const test = () => {
    if (!canEdit || pending) return;
    setMsg(null);
    startTransition(async () => {
      try {
        await testSlackWebhookAction(slug);
        setMsg({ kind: 'ok', text: 'Test message sent. Check your Slack channel.' });
      } catch (e) {
        setMsg({ kind: 'err', text: (e as Error)?.message ?? 'Test failed' });
      }
    });
  };

  const clear = () => {
    if (!canEdit || pending) return;
    if (!confirm('Remove the Slack webhook? Notifications will stop being delivered.')) return;
    setMsg(null);
    startTransition(async () => {
      try {
        await clearSlackWebhookAction(slug);
        setConfigured(false);
        setCreatedAt(null);
        setMsg({ kind: 'ok', text: 'Webhook removed.' });
      } catch (e) {
        setMsg({ kind: 'err', text: (e as Error)?.message ?? 'Remove failed' });
      }
    });
  };

  return (
    <div className="space-y-3">
      <Card className="p-4">
        {configured ? (
          <div className="space-y-3">
            <div className="flex items-center gap-2 text-[13px]">
              <span className="h-[6px] w-[6px] rounded-full bg-positive" />
              <span className="text-ink">Slack webhook configured</span>
              {createdAt && (
                <span className="font-mono text-[11px] text-muted">
                  · added {formatRelative(createdAt)}
                </span>
              )}
            </div>
            <p className="m-0 text-[12.5px] text-muted">
              The URL is stored encrypted; we never display it back. To rotate, paste a new
              URL below and save.
            </p>
            {canEdit && (
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={test}
                  disabled={pending}
                  className="border border-hair bg-paper px-3 py-1.5 font-mono text-[11px] text-ink hover:bg-bg"
                >
                  Send test message
                </button>
                <button
                  type="button"
                  onClick={clear}
                  disabled={pending}
                  className="border border-hair bg-paper px-3 py-1.5 font-mono text-[11px] text-energy-deep hover:bg-bg"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        ) : (
          <p className="m-0 text-[13px] text-muted">
            Not configured. Paste an Incoming Webhook URL below to start delivering
            digests and SLO breach alerts to Slack.
          </p>
        )}
      </Card>

      {canEdit && (
        <Card className="p-4">
          <label className="block">
            <span className="mb-1 block font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted">
              {configured ? 'Rotate webhook URL' : 'Incoming webhook URL'}
            </span>
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://hooks.slack.com/services/T000/B000/XXXX"
              className="w-full border border-hair bg-paper px-2 py-1.5 font-mono text-[12px]"
            />
          </label>
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="border border-ink bg-ink px-3 py-1.5 font-mono text-[11px] text-paper disabled:opacity-60"
            >
              {pending ? 'Saving…' : configured ? 'Rotate' : 'Save'}
            </button>
          </div>
        </Card>
      )}

      {msg && (
        <p
          className={
            'm-0 font-mono text-[11.5px] ' +
            (msg.kind === 'ok' ? 'text-positive-deep' : 'text-energy-deep')
          }
        >
          {msg.text}
        </p>
      )}

      <p className="m-0 text-[12px] text-muted">
        How to get a URL: in Slack, add the{' '}
        <a
          href="https://api.slack.com/messaging/webhooks"
          target="_blank"
          rel="noreferrer"
          className="text-accent underline-offset-[3px] hover:underline"
        >
          Incoming Webhooks app
        </a>{' '}
        to a channel and copy the generated URL.
      </p>

      {!canEdit && (
        <p className="m-0 text-[12px] text-muted">Only admins can change this.</p>
      )}
    </div>
  );
}

function formatRelative(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const days = Math.floor(diffMs / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  return d.toLocaleDateString();
}
