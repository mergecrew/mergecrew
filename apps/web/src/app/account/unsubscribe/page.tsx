import { Card, PageHead } from '@/components/ui';

interface UnsubscribeResult {
  unsubscribed: true;
  email: string;
}

async function callUnsubscribe(token: string): Promise<UnsubscribeResult | { error: string }> {
  const apiBase = process.env.API_BASE_URL ?? 'http://localhost:4000';
  try {
    const r = await fetch(
      `${apiBase}/v1/notifications/unsubscribe?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
      },
    );
    if (!r.ok) {
      const body = await r.json().catch(() => null);
      const msg = (body as { message?: string } | null)?.message ?? `unsubscribe failed (${r.status})`;
      return { error: msg };
    }
    return (await r.json()) as UnsubscribeResult;
  } catch (e) {
    return { error: (e as Error)?.message ?? 'unsubscribe failed' };
  }
}

export default async function UnsubscribePage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const sp = await searchParams;
  const token = sp.token ?? '';
  const result = token ? await callUnsubscribe(token) : { error: 'missing token' };

  return (
    <main className="mx-auto max-w-[640px] px-4 py-10 sm:px-9">
      <PageHead crumb={[{ label: 'Account', href: '/account' }, { label: 'Unsubscribe' }]} title="Unsubscribe" />
      <Card className="p-6">
        {'unsubscribed' in result ? (
          <>
            <p className="m-0 text-[14px] text-ink">
              <b>{result.email}</b> will no longer receive daily digest emails from
              mergecrew.
            </p>
            <p className="mt-3 m-0 text-[12.5px] text-muted">
              Change your mind?{' '}
              <a
                href="/account#notifications"
                className="text-accent underline-offset-[3px] hover:underline"
              >
                Re-enable from your account page →
              </a>
            </p>
          </>
        ) : (
          <>
            <p className="m-0 text-[14px] text-energy-deep">
              Unsubscribe failed: <span className="font-mono">{result.error}</span>
            </p>
            <p className="mt-3 m-0 text-[12.5px] text-muted">
              The link may have expired (tokens last 90 days). Sign in and turn the
              digest off from your{' '}
              <a
                href="/account#notifications"
                className="text-accent underline-offset-[3px] hover:underline"
              >
                account notifications page
              </a>
              .
            </p>
          </>
        )}
      </Card>
    </main>
  );
}
