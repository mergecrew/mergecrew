/**
 * Eval runner CLI (#299).
 *
 *   pnpm --filter @mergecrew/eval-runner run --org <slug> --profile <profile-id> [--fixtures id1,id2]
 *
 * Drives the eval-fixtures corpus against the org's configured LLM
 * profile. For each fixture: extracts the workspace, builds a
 * "produce a unified diff for this intent" prompt, calls the LLM via
 * @mergecrew/llm, and writes an EvalCase row carrying the response,
 * cost, and latency. Snapshot pass/fail comparison lands in #300 —
 * V2.ab #299 marks every case `pass` if the LLM returned without an
 * error so the surrounding plumbing (runs + cases + aggregates) can
 * be tested end-to-end without the comparison.
 */

import { withSystem, withTenant } from '@mergecrew/db';
import { listFixtures, loadFixture, type LoadedFixture } from '@mergecrew/eval-fixtures';
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
    else if (a === '--source') {
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
  const { promises: fs } = await import('node:fs');
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

async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));

  // Resolve the org via the migrator role (system bypass) so the CLI
  // can be invoked without an authenticated user context.
  const org = await withSystem((tx) =>
    tx.organization.findUnique({ where: { slug: cli.orgSlug } }),
  );
  if (!org) {
    console.error(`org not found: ${cli.orgSlug}`);
    process.exit(1);
  }
  const organizationId = org.id;

  // Resolve profile + providers from the tenant scope.
  const [providers, profileRow] = await Promise.all([
    withTenant(organizationId, (tx) => tx.llmProvider.findMany({ where: { organizationId } })),
    cli.profileId
      ? withTenant(organizationId, (tx) =>
          tx.llmProfile.findUnique({ where: { id: cli.profileId! } }),
        )
      : withTenant(organizationId, (tx) =>
          tx.llmProfile.findFirst({ where: { organizationId }, orderBy: { createdAt: 'asc' } }),
        ),
  ]);
  if (!profileRow) {
    console.error(`no LLM profile available for org ${cli.orgSlug}`);
    process.exit(1);
  }
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

  // Resolve the first preferred provider/model — V2.ab keeps the
  // routing trivially simple. Full capability-routing arrives if/when
  // the eval suite needs to exercise per-capability routing.
  const pref = (profileRow.preferenceOrder as string[]) ?? [];
  const firstPref = pref[0];
  if (!firstPref || !firstPref.includes('/')) {
    console.error(`profile ${profileRow.id} has no usable preferenceOrder`);
    process.exit(1);
  }
  const [providerKind, modelId] = firstPref.split('/');
  const providerCfg = configs.find((c) => c.kind === providerKind);
  if (!providerCfg) {
    console.error(`no provider config matching kind ${providerKind} (from ${firstPref})`);
    process.exit(1);
  }

  // Decide the fixture set: explicit `--fixtures` overrides the
  // default "all" mode.
  const allIds = await listFixtures();
  const targetIds = cli.fixtureIds && cli.fixtureIds.length > 0
    ? cli.fixtureIds.filter((id) => allIds.includes(id))
    : allIds;
  if (targetIds.length === 0) {
    console.error('no fixtures matched');
    process.exit(1);
  }

  // Open the EvalRun row up front so a crashed harness still leaves a
  // visible record. finishedAt + aggregates are filled in after.
  const evalRun = await withTenant(organizationId, (tx) =>
    tx.evalRun.create({
      data: {
        organizationId,
        llmProfileId: profileRow.id,
        source: cli.source,
        totalCases: targetIds.length,
      },
    }),
  );
  console.log(`evalRun ${evalRun.id}: ${targetIds.length} fixtures, profile=${profileRow.name}, provider=${providerKind}/${modelId}`);

  let passCount = 0;
  let failCount = 0;
  let errorCount = 0;
  let totalUsd = 0;
  let totalLatencyMs = 0;

  for (const id of targetIds) {
    const caseStart = Date.now();
    try {
      const fixture = await loadFixture(id);
      const tree = await listTreeTop(fixture.workspacePath);
      const { system, human } = buildPrompt(fixture, tree);
      const result = await chat({
        registry,
        providerId: providerCfg!.id,
        modelId: modelId!,
        messages: [new SystemMessage(system), new HumanMessage(human)],
        maxTokens: 2000,
      });
      const price = await priceFor(organizationId, providerCfg!.kind, modelId!, new Date());
      const usd = price ? estimateUsd(price, result.usage) : 0;
      totalUsd += usd;
      totalLatencyMs += result.latencyMs;
      // V2.ab #299 marks every successful response as `pass` so the
      // surrounding plumbing is exercisable. #300 replaces this with
      // a real snapshot comparison against expected.diff.
      passCount++;
      await withTenant(organizationId, (tx) =>
        tx.evalCase.create({
          data: {
            evalRunId: evalRun.id,
            fixtureId: id,
            status: 'pass',
            agentDiff: result.content,
            usdEstimate: usd as any,
            latencyMs: result.latencyMs,
          },
        }),
      );
      console.log(`  ${id}: pass · ${result.latencyMs}ms · $${usd.toFixed(4)}`);
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
  process.exit(errorCount > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('eval-runner: fatal', err);
  process.exit(1);
});
