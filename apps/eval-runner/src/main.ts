/**
 * Eval runner CLI (#299 + #302).
 *
 *   pnpm --filter @mergecrew/eval-runner run -- \
 *     --org <slug> [--profile <profile-id>] [--fixtures id1,id2]
 *
 *   # A/B compare (#302): run each fixture twice, once per profile,
 *   # wrap both runs in an EvalAbRun the compare page reads.
 *   pnpm --filter @mergecrew/eval-runner run -- \
 *     --org <slug> --ab <profile-a-id>,<profile-b-id>
 *
 * For each fixture: extract via @mergecrew/eval-fixtures, build a
 * "produce a unified diff" prompt, call the LLM, compare the response
 * to the fixture's `expected.diff` (via compareSnapshot), persist an
 * EvalCase row carrying status / cost / latency / mismatch summary.
 */

import { promises as fs } from 'node:fs';
import { withSystem, withTenant } from '@mergecrew/db';
import {
  compareSnapshot,
  listFixtures,
  loadFixture,
  type LoadedFixture,
  type SnapshotMismatch,
} from '@mergecrew/eval-fixtures';
import {
  ProviderRegistry,
  chat,
  estimateUsd,
  priceFor,
  type ProviderConfig,
} from '@mergecrew/llm';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';

interface Cli {
  orgSlug: string;
  profileId?: string;
  fixtureIds?: string[];
  source: 'cli' | 'cron' | 'ab';
  /** A/B mode (#302): `[profileA, profileB]`. */
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

function summarizeMismatches(mismatches: SnapshotMismatch[]): string {
  if (mismatches.length === 0) return '';
  return mismatches
    .map((m) => {
      switch (m.kind) {
        case 'missing_required_file':
          return `missing required file: ${m.path}`;
        case 'unexpected_file':
          return `unexpected file: ${m.path}`;
        case 'untouched_expected_file':
          return `untouched expected file: ${m.path}`;
        case 'low_overlap':
          return `low overlap on ${m.path}: ${m.overlap.toFixed(2)} < ${m.threshold}`;
      }
    })
    .join('; ');
}

function decryptDevOnly(blob: Buffer): string {
  // Mirrors apps/runner/src/step.ts decryptDevOnly — same KMS_MASTER_KEY
  // contract. Lifted later into a shared @mergecrew/crypto helper.
  const crypto = require('node:crypto');
  const v = process.env.KMS_MASTER_KEY ?? '';
  const buf = Buffer.from(v.replace(/^base64:/, ''), 'base64');
  if (buf.length !== 32) return '';
  if (blob[0] !== 1) return '';
  let pos = 1;
  const wrapIv = blob.subarray(pos, pos + 12); pos += 12;
  const wrapTag = blob.subarray(pos, pos + 16); pos += 16;
  const wrapped = blob.subarray(pos, pos + 32); pos += 32;
  const iv = blob.subarray(pos, pos + 12); pos += 12;
  const tag = blob.subarray(pos, pos + 16); pos += 16;
  const ct = blob.subarray(pos);
  const wrap = crypto.createDecipheriv('aes-256-gcm', buf, wrapIv);
  wrap.setAuthTag(wrapTag);
  const dataKey = Buffer.concat([wrap.update(wrapped), wrap.final()]);
  const dec = crypto.createDecipheriv('aes-256-gcm', dataKey, iv);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(ct), dec.final()]).toString('utf8');
}

function buildPrompt(fixture: LoadedFixture, treeSummary: string): { system: string; human: string } {
  const system = [
    'You are an autonomous coding agent running an evaluation case.',
    'You will be given an intent and a brief summary of the working tree.',
    'Produce a SINGLE unified diff (git-format) that satisfies the intent.',
    'Output ONLY the diff between ```diff fences — no explanation, no extra commentary.',
    'Touch only files reasonably implied by the intent. Do not modify package.json, lockfiles, configs, or test files unless the intent says so.',
  ].join('\n');
  const human = [
    `# Intent`,
    fixture.manifest.intent,
    ``,
    `# Working tree (top-level)`,
    treeSummary,
    ``,
    `# Required files`,
    fixture.manifest.expectedFiles.length > 0
      ? fixture.manifest.expectedFiles.map((f) => `- ${f}`).join('\n')
      : '(no specific files required — let the intent guide you)',
  ].join('\n');
  return { system, human };
}

async function listTreeTop(workspacePath: string): Promise<string> {
  const path = await import('node:path');
  async function walk(dir: string, prefix = ''): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const lines: string[] = [];
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith('.')) continue;
      if (e.name === 'node_modules') continue;
      const p = path.join(prefix, e.name);
      if (e.isDirectory()) {
        lines.push(`${p}/`);
        const sub = await walk(path.join(dir, e.name), p);
        lines.push(...sub.slice(0, 20));
      } else {
        lines.push(p);
      }
    }
    return lines;
  }
  const all = await walk(workspacePath);
  return all.slice(0, 80).join('\n');
}

interface RunInputs {
  organizationId: string;
  configs: ProviderConfig[];
  registry: ProviderRegistry;
  profileRow: {
    id: string;
    name: string;
    preferenceOrder: unknown;
  };
  fixtureIds: string[];
  source: 'cli' | 'cron' | 'ab';
}

async function runFixturesForProfile(input: RunInputs): Promise<{ evalRunId: string; pass: number; fail: number; error: number }> {
  const { organizationId, configs, registry, profileRow, fixtureIds, source } = input;
  const pref = (profileRow.preferenceOrder as string[]) ?? [];
  const firstPref = pref[0];
  if (!firstPref || !firstPref.includes('/')) {
    throw new Error(`profile ${profileRow.id} has no usable preferenceOrder`);
  }
  const [providerKind, modelId] = firstPref.split('/');
  const providerCfg = configs.find((c) => c.kind === providerKind);
  if (!providerCfg) {
    throw new Error(`no provider config matching kind ${providerKind} (from ${firstPref})`);
  }

  const evalRun = await withTenant(organizationId, (tx) =>
    tx.evalRun.create({
      data: {
        organizationId,
        llmProfileId: profileRow.id,
        source,
        totalCases: fixtureIds.length,
      },
    }),
  );
  console.log(
    `evalRun ${evalRun.id}: ${fixtureIds.length} fixtures, profile=${profileRow.name}, provider=${providerKind}/${modelId}`,
  );

  let passCount = 0;
  let failCount = 0;
  let errorCount = 0;
  let totalUsd = 0;
  let totalLatencyMs = 0;

  for (const id of fixtureIds) {
    const caseStart = Date.now();
    try {
      const fixture = await loadFixture(id);
      const tree = await listTreeTop(fixture.workspacePath);
      const { system, human } = buildPrompt(fixture, tree);
      const result = await chat({
        registry,
        providerId: providerCfg.id,
        modelId: modelId!,
        messages: [new SystemMessage(system), new HumanMessage(human)],
        maxTokens: 2000,
      });
      const price = await priceFor(organizationId, providerCfg.kind, modelId!, new Date());
      const usd = price ? estimateUsd(price, result.usage) : 0;
      totalUsd += usd;
      totalLatencyMs += result.latencyMs;
      const expectedDiff = await fs.readFile(fixture.expectedDiffPath, 'utf8');
      const verdict = compareSnapshot(result.content, expectedDiff, fixture.manifest.tolerances);
      let status: 'pass' | 'fail';
      let errorMessage: string | undefined;
      if (verdict.pass) {
        passCount++;
        status = 'pass';
      } else {
        failCount++;
        status = 'fail';
        errorMessage = summarizeMismatches(verdict.mismatches);
      }
      await withTenant(organizationId, (tx) =>
        tx.evalCase.create({
          data: {
            evalRunId: evalRun.id,
            fixtureId: id,
            status,
            agentDiff: result.content,
            ...(errorMessage ? { errorMessage } : {}),
            usdEstimate: usd as any,
            latencyMs: result.latencyMs,
          },
        }),
      );
      console.log(
        `  ${id}: ${verdict.pass ? 'pass' : `fail · ${errorMessage}`} · ${result.latencyMs}ms · $${usd.toFixed(4)}`,
      );
    } catch (err) {
      errorCount++;
      const message = err instanceof Error ? err.message : String(err);
      totalLatencyMs += Date.now() - caseStart;
      await withTenant(organizationId, (tx) =>
        tx.evalCase.create({
          data: {
            evalRunId: evalRun.id,
            fixtureId: id,
            status: 'error',
            errorMessage: message,
            latencyMs: Date.now() - caseStart,
          },
        }),
      );
      console.log(`  ${id}: error · ${message}`);
    }
  }

  await withTenant(organizationId, (tx) =>
    tx.evalRun.update({
      where: { id: evalRun.id },
      data: {
        finishedAt: new Date(),
        passCount,
        failCount,
        errorCount,
        totalUsd: totalUsd as any,
        totalLatencyMs,
      },
    }),
  );
  console.log(
    `\nevalRun ${evalRun.id}: ${passCount} pass, ${failCount} fail, ${errorCount} error · $${totalUsd.toFixed(4)} · ${totalLatencyMs}ms total`,
  );

  return { evalRunId: evalRun.id, pass: passCount, fail: failCount, error: errorCount };
}

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  const org = await withSystem((tx) =>
    tx.organization.findUnique({ where: { slug: cli.orgSlug } }),
  );
  if (!org) {
    console.error(`org not found: ${cli.orgSlug}`);
    process.exit(1);
  }
  const organizationId = org.id;

  const providers = await withTenant(organizationId, (tx) =>
    tx.llmProvider.findMany({ where: { organizationId } }),
  );
  if (providers.length === 0) {
    console.error(`no LLM providers registered for org ${cli.orgSlug}`);
    process.exit(1);
  }

  const configs: ProviderConfig[] = providers.map((p) => ({
    id: p.id,
    kind: p.kind as any,
    apiKey: p.credentialCiphertext ? decryptDevOnly(p.credentialCiphertext) : undefined,
    endpoint: p.endpoint ?? undefined,
    awsRegion: process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
    models: ((p.capabilityOverrides as any)?.models ?? []) as string[],
  }));
  const registry = new ProviderRegistry(configs);

  const allIds = await listFixtures();
  const targetIds = cli.fixtureIds && cli.fixtureIds.length > 0
    ? cli.fixtureIds.filter((id) => allIds.includes(id))
    : allIds;
  if (targetIds.length === 0) {
    console.error('no fixtures matched');
    process.exit(1);
  }

  // A/B mode (#302). Run the corpus once per profile, then wrap both
  // EvalRuns under an EvalAbRun so the compare dashboard can find them.
  if (cli.ab) {
    const [profileAId, profileBId] = cli.ab;
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
          runAId: '00000000-0000-0000-0000-000000000000', // backfilled after the runs land
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
    });
    console.log(`\n--- profile B: ${profileB.name} ---`);
    const runB = await runFixturesForProfile({
      organizationId,
      configs,
      registry,
      profileRow: profileB,
      fixtureIds: targetIds,
      source: 'ab',
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
  const profileRow = cli.profileId
    ? await withTenant(organizationId, (tx) => tx.llmProfile.findUnique({ where: { id: cli.profileId! } }))
    : await withTenant(organizationId, (tx) =>
        tx.llmProfile.findFirst({ where: { organizationId }, orderBy: { createdAt: 'asc' } }),
      );
  if (!profileRow) {
    console.error(`no LLM profile available for org ${cli.orgSlug}`);
    process.exit(1);
  }
  const out = await runFixturesForProfile({
    organizationId,
    configs,
    registry,
    profileRow,
    fixtureIds: targetIds,
    source: cli.source,
  });
  process.exit(out.error > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('eval-runner: fatal', err);
  process.exit(1);
});
