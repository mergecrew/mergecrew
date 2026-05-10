import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import type {
  DetectedFramework,
  DetectedScript,
  DetectedWorkflow,
  FrameworkKind,
  InceptionSummary,
  ScriptKind,
} from './types.js';

/**
 * Walk a freshly-cloned workspace and produce a structured InceptionSummary.
 * Pure file reads — no network, no shell. Safe to run on untrusted code.
 *
 * Detection is best-effort and intentionally conservative: when a signal
 * is ambiguous we omit it from the summary rather than guess. The user
 * confirms in the setup wizard, so over-reporting causes more friction
 * than under-reporting.
 */
export async function detectStack(workspacePath: string): Promise<InceptionSummary> {
  const [frameworks, scripts, workflows] = await Promise.all([
    detectFrameworks(workspacePath),
    detectScripts(workspacePath),
    detectWorkflows(workspacePath),
  ]);
  return { frameworks, scripts, workflows };
}

// ─── Frameworks ────────────────────────────────────────────────────────────

const PACKAGE_JSON_FRAMEWORK_RULES: Array<{
  kind: FrameworkKind;
  label: (v: string) => string;
  packages: string[];
}> = [
  { kind: 'nextjs', label: (v) => `Next.js ${v}`, packages: ['next'] },
  { kind: 'react', label: (v) => `React ${v}`, packages: ['react'] },
  { kind: 'nestjs', label: (v) => `NestJS ${v}`, packages: ['@nestjs/core'] },
  { kind: 'express', label: (v) => `Express ${v}`, packages: ['express'] },
  { kind: 'fastify', label: (v) => `Fastify ${v}`, packages: ['fastify'] },
  { kind: 'vite', label: (v) => `Vite ${v}`, packages: ['vite'] },
  { kind: 'astro', label: (v) => `Astro ${v}`, packages: ['astro'] },
  { kind: 'remix', label: (v) => `Remix ${v}`, packages: ['@remix-run/react'] },
  { kind: 'svelte', label: (v) => `Svelte ${v}`, packages: ['svelte'] },
  { kind: 'vue', label: (v) => `Vue ${v}`, packages: ['vue'] },
  { kind: 'prisma', label: (v) => `Prisma ${v}`, packages: ['@prisma/client', 'prisma'] },
  { kind: 'drizzle', label: (v) => `Drizzle ${v}`, packages: ['drizzle-orm'] },
  { kind: 'turbo', label: (v) => `Turborepo ${v}`, packages: ['turbo'] },
];

async function detectFrameworks(workspacePath: string): Promise<DetectedFramework[]> {
  const out: DetectedFramework[] = [];
  const seen = new Set<FrameworkKind>();

  // Root package.json frameworks.
  const rootPkg = await readJson<PkgJson>(path.join(workspacePath, 'package.json'));
  if (rootPkg) {
    for (const rule of PACKAGE_JSON_FRAMEWORK_RULES) {
      for (const dep of rule.packages) {
        const v = lookupDependencyVersion(rootPkg, dep);
        if (v && !seen.has(rule.kind)) {
          seen.add(rule.kind);
          out.push({
            kind: rule.kind,
            label: rule.label(stripCaret(v)),
            version: stripCaret(v),
            evidence: 'package.json',
          });
          break;
        }
      }
    }
  }

  // TypeScript: tsconfig.json existence is enough.
  if (!seen.has('typescript') && (await exists(path.join(workspacePath, 'tsconfig.json')))) {
    seen.add('typescript');
    out.push({ kind: 'typescript', label: 'TypeScript', evidence: 'tsconfig.json' });
  }

  // Docker: any Dockerfile or compose file.
  const dockerEvidence = await firstExisting(workspacePath, [
    'Dockerfile',
    'docker-compose.yml',
    'docker-compose.yaml',
    'compose.yml',
  ]);
  if (dockerEvidence && !seen.has('docker')) {
    seen.add('docker');
    out.push({ kind: 'docker', label: 'Docker', evidence: dockerEvidence });
  }

  // pnpm workspace.
  if (
    !seen.has('pnpm-workspace') &&
    (await exists(path.join(workspacePath, 'pnpm-workspace.yaml')))
  ) {
    seen.add('pnpm-workspace');
    out.push({ kind: 'pnpm-workspace', label: 'pnpm workspace', evidence: 'pnpm-workspace.yaml' });
  }

  // Prisma schema (separate from the @prisma/client dep — covers schema-only repos).
  if (!seen.has('prisma')) {
    const prismaSchema = await firstExisting(workspacePath, [
      'prisma/schema.prisma',
      'packages/db/prisma/schema.prisma',
    ]);
    if (prismaSchema) {
      seen.add('prisma');
      out.push({ kind: 'prisma', label: 'Prisma', evidence: prismaSchema });
    }
  }

  // Drizzle config (covers drizzle-kit-only repos).
  if (!seen.has('drizzle')) {
    const drizzleCfg = await firstExisting(workspacePath, [
      'drizzle.config.ts',
      'drizzle.config.js',
      'drizzle.config.mjs',
    ]);
    if (drizzleCfg) {
      seen.add('drizzle');
      out.push({ kind: 'drizzle', label: 'Drizzle', evidence: drizzleCfg });
    }
  }

  return out;
}

// ─── Scripts ───────────────────────────────────────────────────────────────

async function detectScripts(workspacePath: string): Promise<DetectedScript[]> {
  const pkg = await readJson<PkgJson>(path.join(workspacePath, 'package.json'));
  if (!pkg?.scripts) return [];
  return Object.entries(pkg.scripts).map(([name, cmd]) => ({
    name,
    cmd,
    kind: classifyScript(name, cmd),
    source: 'package.json',
  }));
}

function classifyScript(name: string, cmd: string): ScriptKind {
  const n = name.toLowerCase();
  const c = cmd.toLowerCase();
  if (n === 'test' || n.startsWith('test:') || /\b(vitest|jest|playwright|mocha|ava)\b/.test(c)) {
    return 'test';
  }
  if (n === 'lint' || n.startsWith('lint:') || /\b(eslint|biome|standard)\b/.test(c)) {
    return 'lint';
  }
  if (n === 'typecheck' || n === 'type-check' || /\btsc\b/.test(c)) {
    return 'typecheck';
  }
  if (n === 'build' || n.startsWith('build:') || /\bnext build\b|\bvite build\b|\btsup\b/.test(c)) {
    return 'build';
  }
  if (n === 'dev' || n.startsWith('dev:') || n === 'start' || /\bnext dev\b|\bvite\b\s|\btsx watch\b/.test(c)) {
    return 'dev';
  }
  return 'unknown';
}

// ─── Workflows ─────────────────────────────────────────────────────────────

async function detectWorkflows(workspacePath: string): Promise<DetectedWorkflow[]> {
  const dir = path.join(workspacePath, '.github', 'workflows');
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: DetectedWorkflow[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.yml') && !entry.endsWith('.yaml')) continue;
    const full = path.join(dir, entry);
    const text = await fs.readFile(full, 'utf8').catch(() => '');
    if (!text) continue;
    let parsed: any;
    try {
      parsed = YAML.parse(text);
    } catch {
      continue; // malformed yaml
    }
    const events = extractEvents(parsed);
    const dispatchInputs = extractDispatchInputs(parsed);
    const acceptsCorrelationId = Object.prototype.hasOwnProperty.call(
      dispatchInputs ?? {},
      'mergecrew_correlation_id',
    );
    const lower = entry.toLowerCase();
    const isDeployCandidate =
      /deploy/.test(lower) ||
      events.includes('workflow_dispatch') ||
      /publish/.test(lower) ||
      /release/.test(lower);
    out.push({
      path: path.posix.join('.github/workflows', entry),
      events,
      isDeployCandidate,
      acceptsCorrelationId,
    });
  }
  // Sort deploy candidates first (most useful for the wizard).
  out.sort((a, b) => Number(b.isDeployCandidate) - Number(a.isDeployCandidate));
  return out;
}

function extractEvents(parsed: any): string[] {
  const on = parsed?.on;
  if (!on) return [];
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.filter((x) => typeof x === 'string');
  if (typeof on === 'object') return Object.keys(on);
  return [];
}

function extractDispatchInputs(parsed: any): Record<string, unknown> | null {
  const on = parsed?.on;
  if (!on || typeof on !== 'object') return null;
  const wd = (on as any).workflow_dispatch;
  if (!wd || typeof wd !== 'object') return null;
  return (wd as any).inputs ?? null;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

interface PkgJson {
  name?: string;
  version?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function firstExisting(root: string, candidates: string[]): Promise<string | null> {
  for (const c of candidates) {
    if (await exists(path.join(root, c))) return c;
  }
  return null;
}

function lookupDependencyVersion(pkg: PkgJson, dep: string): string | null {
  return (
    pkg.dependencies?.[dep] ??
    pkg.devDependencies?.[dep] ??
    pkg.peerDependencies?.[dep] ??
    null
  );
}

function stripCaret(v: string): string {
  return v.replace(/^[\^~>=<\s]+/, '').trim();
}
