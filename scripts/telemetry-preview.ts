/* eslint-disable no-console */
/**
 * `pnpm telemetry:preview` — prints the exact payload the next install
 * ping would send, without sending it. Useful for auditors / paranoid
 * operators verifying what leaves their box (#322).
 */

import { buildInstallPingPayload } from '../apps/worker-cron/src/install-ping-tick.js';

async function main(): Promise<void> {
  const version = process.env.MERGECREW_VERSION ?? '0.1.0';
  const payload = await buildInstallPingPayload(version);
  if (!payload) {
    console.log('telemetry:preview: no org has opted in (default). No ping is scheduled.');
    console.log('To opt in: Settings → Anonymous install telemetry → Enable.');
    process.exit(0);
  }
  const url = process.env.MERGECREW_TELEMETRY_URL?.trim();
  console.log('Endpoint:', url ?? '(none — NoopTransport active; nothing sent over the wire)');
  console.log('Payload (next scheduled ping):');
  console.log(JSON.stringify(payload, null, 2));
}

main().catch((err) => {
  console.error('telemetry:preview: fatal', err);
  process.exit(1);
});
