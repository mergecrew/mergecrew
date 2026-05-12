/**
 * Eval runner CLI. Thin wrapper around `runEvalsForOrg` (#299 + #303)
 * and the inline A/B compare (#302).
 *
 *   pnpm --filter @mergecrew/eval-runner run -- --org demo
 *   pnpm --filter @mergecrew/eval-runner run -- --org demo --profile <id>
 *   pnpm --filter @mergecrew/eval-runner run -- --org demo --ab <a>,<b>
 */

import { withTenant } from '@mergecrew/db';
import {
  buildOrgRegistry,
  runEvalsForOrg,
  runFixturesForProfile,
} from './run.js';

interface Cli {
  orgSlug: string;
  profileId?: string;
  fixtureIds?: string[];
  source: 'cli' | 'cron' | 'ab';
  ab?: [string, string];
}

function parseArgs(argv: string[]): Cli {
  const out: Cli = { orgSlug: '', source: 'cli' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[i + 1];
      if (v == null) throw new Error(`missing value for ${a}`);
      i++;
      return v;
    };
    if (a === '--org') out.orgSlug = next();
    else if (a === '--profile') out.profileId = next();
    else if (a === '--fixtures') out.fixtureIds = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--ab') {
      const pair = next()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (pair.length !== 2 || !pair[0] || !pair[1]) {
        throw new Error('--ab must be <profile-a-id>,<profile-b-id>');
      }
      out.ab = [pair[0], pair[1]];
      out.source = 'ab';
    } else if (a === '--source') {
      const s = next();
      if (s !== 'cli' && s !== 'cron' && s !== 'ab') {
        throw new Error(`--source must be cli|cron|ab, got ${s}`);
      }
      out.source = s;
    }
  }
  if (!out.orgSlug) throw new Error('--org <slug> is required');
  return out;
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  // A/B compare path (#302). Resolves the org's registry once, opens
  // an EvalAbRun up front, runs each profile, back-patches the wrapper.
  if (cli.ab) {
    const [profileAId, profileBId] = cli.ab;
    const { organizationId, configs, registry } = await buildOrgRegistry(cli.orgSlug);
    const { listFixtures } = await import('@mergecrew/eval-fixtures');
    const allIds = await listFixtures();
    const targetIds = cli.fixtureIds && cli.fixtureIds.length > 0
      ? cli.fixtureIds.filter((id) => allIds.includes(id))
      : allIds;
    const [profileA, profileB] = await Promise.all([
      withTenant(organizationId, (tx) => tx.llmProfile.findUnique({ where: { id: profileAId! } })),
      withTenant(organizationId, (tx) => tx.llmProfile.findUnique({ where: { id: profileBId! } })),
    ]);
    if (!profileA || !profileB) {
      console.error(`one or both profiles not found: ${profileAId} / ${profileBId}`);
      process.exit(1);
    }
    const ab = await withTenant(organizationId, (tx) =>
      tx.evalAbRun.create({
        data: {
          organizationId,
          profileAId: profileA.id,
          profileBId: profileB.id,
          runAId: '00000000-0000-0000-0000-000000000000',
          runBId: '00000000-0000-0000-0000-000000000000',
        },
      }),
    );
    console.log(`evalAbRun ${ab.id}: comparing ${profileA.name} vs ${profileB.name}\n`);
    console.log(`--- profile A: ${profileA.name} ---`);
    const runA = await runFixturesForProfile({
      organizationId,
      configs,
      registry,
      profileRow: profileA,
      fixtureIds: targetIds,
      source: 'ab',
      log: console.log,
    });
    console.log(`\n--- profile B: ${profileB.name} ---`);
    const runB = await runFixturesForProfile({
      organizationId,
      configs,
      registry,
      profileRow: profileB,
      fixtureIds: targetIds,
      source: 'ab',
      log: console.log,
    });
    await withTenant(organizationId, (tx) =>
      tx.evalAbRun.update({
        where: { id: ab.id },
        data: {
          runAId: runA.evalRunId,
          runBId: runB.evalRunId,
          finishedAt: new Date(),
        },
      }),
    );
    console.log(`\nevalAbRun ${ab.id}: complete (A: ${runA.pass} pass, B: ${runB.pass} pass)`);
    process.exit(runA.error > 0 || runB.error > 0 ? 1 : 0);
  }

  // Default single-profile run.
  const out = await runEvalsForOrg({
    orgSlug: cli.orgSlug,
    ...(cli.profileId ? { profileId: cli.profileId } : {}),
    ...(cli.fixtureIds ? { fixtureIds: cli.fixtureIds } : {}),
    source: cli.source,
  });
  console.log(
    `\nevalRun ${out.evalRunId}: ${out.pass} pass, ${out.fail} fail, ${out.error} error · $${out.totalUsd.toFixed(4)} · ${out.totalLatencyMs}ms total`,
  );
  process.exit(out.error > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('eval-runner: fatal', err);
  process.exit(1);
});
