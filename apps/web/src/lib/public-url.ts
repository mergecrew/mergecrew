import { headers } from 'next/headers';

/**
 * The public URL the user has loaded in their browser, derived from
 * the request's `Host` + `X-Forwarded-Proto` headers.
 *
 * Use this when surfacing a URL that must be reachable from **outside**
 * the compose network — most importantly, the `--api-url` we pass to
 * the `mergecrew/runner-agent` container running on an external host.
 * `API_BASE_URL` from env is internal-only (`http://api:4000`) and
 * unusable from a remote agent.
 *
 * Falls back to `MERGECREW_PUBLIC_API_BASE_URL` then `WEB_BASE_URL`
 * for non-request contexts (ISR, background revalidation, build).
 * Final placeholder string is intentional — operators editing dev
 * env without these vars set should see a literal `<your-mergecrew-host>`
 * rather than the internal address.
 */
export async function publicBaseUrl(): Promise<string> {
  try {
    const h = await headers();
    const host = h.get('host');
    if (host) {
      const proto = h.get('x-forwarded-proto') ?? 'https';
      return `${proto}://${host}`;
    }
  } catch {
    // headers() throws outside request scope.
  }
  return (
    process.env.MERGECREW_PUBLIC_API_BASE_URL ??
    process.env.WEB_BASE_URL ??
    '<your-mergecrew-host>'
  );
}
