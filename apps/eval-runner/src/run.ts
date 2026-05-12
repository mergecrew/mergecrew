/**
 * Eval runner library entry (#303). Exported so the cron tick in
 * worker-cron can invoke the same code path the CLI uses, without
 * subprocess management or duplicate logic.
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

export interface RunEvalsArgs {
  orgSlug: string;
  profileId?: string;
  fixtureIds?: string[];
  source: 'cli' | 'cron' | 'ab';
}

export interface RunEvalsResult {
  evalRunId: string;
  pass: number;
  fail: number;
  error: number;
  totalCases: number;
  totalUsd: number;
  totalLatencyMs: number;
}

function decryptDevOnly(blob: Buffer): string {
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

interface RunForProfileInput {
  organizationId: string;
  configs: ProviderConfig[];
  registry: ProviderRegistry;
  profileRow: { id: string; name: string; preferenceOrder: unknown };
  fixtureIds: string[];
  source: 'cli' | 'cron' | 'ab';
  log: (msg: string) => void;
}

export async function runFixturesForProfile(input: RunForProfileInput): Promise<RunEvalsResult> {
  const { organizationId, configs, registry, profileRow, fixtureIds, source, log } = input;
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
  log(`evalRun ${evalRun.id}: ${fixtureIds.length} fixtures, profile=${profileRow.name}, provider=${providerKind}/${modelId}`);

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
      log(`  ${id}: ${verdict.pass ? 'pass' : `fail · ${errorMessage}`} · ${result.latencyMs}ms · $${usd.toFixed(4)}`);
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
      log(`  ${id}: error · ${message}`);
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

  return {
    evalRunId: evalRun.id,
    pass: passCount,
    fail: failCount,
    error: errorCount,
    totalCases: fixtureIds.length,
    totalUsd,
    totalLatencyMs,
  };
}

/**
 * High-level entry — resolves org / providers / profile and runs the
 * full corpus (or a subset) for the chosen profile. Used by both the
 * CLI's default mode and the worker-cron nightly tick.
 */
export async function runEvalsForOrg(
  args: RunEvalsArgs,
  log: (msg: string) => void = console.log,
): Promise<RunEvalsResult> {
  const org = await withSystem((tx) =>
    tx.organization.findUnique({ where: { slug: args.orgSlug } }),
  );
  if (!org) throw new Error(`org not found: ${args.orgSlug}`);
  const organizationId = org.id;

  const providers = await withTenant(organizationId, (tx) =>
    tx.llmProvider.findMany({ where: { organizationId } }),
  );
  if (providers.length === 0) {
    throw new Error(`no LLM providers registered for org ${args.orgSlug}`);
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

  const profileRow = args.profileId
    ? await withTenant(organizationId, (tx) => tx.llmProfile.findUnique({ where: { id: args.profileId! } }))
    : await withTenant(organizationId, (tx) =>
        tx.llmProfile.findFirst({ where: { organizationId }, orderBy: { createdAt: 'asc' } }),
      );
  if (!profileRow) {
    throw new Error(`no LLM profile available for org ${args.orgSlug}`);
  }

  const allIds = await listFixtures();
  const fixtureIds =
    args.fixtureIds && args.fixtureIds.length > 0
      ? args.fixtureIds.filter((id) => allIds.includes(id))
      : allIds;
  if (fixtureIds.length === 0) {
    throw new Error('no fixtures matched');
  }

  return runFixturesForProfile({
    organizationId,
    configs,
    registry,
    profileRow,
    fixtureIds,
    source: args.source,
    log,
  });
}

/**
 * Resolve the configs + registry for an org without running anything.
 * The A/B compare path uses this to avoid loading twice.
 */
export async function buildOrgRegistry(orgSlug: string): Promise<{
  organizationId: string;
  configs: ProviderConfig[];
  registry: ProviderRegistry;
}> {
  const org = await withSystem((tx) =>
    tx.organization.findUnique({ where: { slug: orgSlug } }),
  );
  if (!org) throw new Error(`org not found: ${orgSlug}`);
  const organizationId = org.id;
  const providers = await withTenant(organizationId, (tx) =>
    tx.llmProvider.findMany({ where: { organizationId } }),
  );
  const configs: ProviderConfig[] = providers.map((p) => ({
    id: p.id,
    kind: p.kind as any,
    apiKey: p.credentialCiphertext ? decryptDevOnly(p.credentialCiphertext) : undefined,
    endpoint: p.endpoint ?? undefined,
    awsRegion: process.env.BEDROCK_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
    models: ((p.capabilityOverrides as any)?.models ?? []) as string[],
  }));
  return { organizationId, configs, registry: new ProviderRegistry(configs) };
}
