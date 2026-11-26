/**
 * Next.js server start hook. Refuses to boot a production server with
 * missing or publicly known secrets (see lib/secrets.ts). Skipped during
 * `next build`, where runtime secrets are intentionally absent. The
 * Node-only work lives in instrumentation-node.ts so the edge bundle
 * never references process.exit.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.NEXT_PHASE === 'phase-production-build') return;
  await import('./instrumentation-node');
}
