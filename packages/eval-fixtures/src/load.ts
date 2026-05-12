import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { FixtureManifest, LoadedFixture, FixtureTolerances } from './types.js';

/**
 * Root directory holding all fixture source trees. Each subdir is one
 * fixture; manifest.yaml sits at the root of each. The packages are
 * compiled to CJS, so __dirname resolves to either `dist/` (runtime)
 * or `src/` (vitest); both are one level below the package root.
 */
function fixturesRoot(): string {
  // From dist/load.js or src/load.ts, go up one to the package root.
  return path.resolve(__dirname, '..', 'fixtures');
}

/**
 * Resolve a fixture id to its source dir. The id matches the dir name
 * exactly — no aliasing. Throws if the dir or manifest is missing.
 */
async function resolveFixtureDir(id: string): Promise<string> {
  const dir = path.join(fixturesRoot(), id);
  try {
    const stat = await fs.stat(dir);
    if (!stat.isDirectory()) throw new Error(`fixture path is not a directory: ${dir}`);
  } catch (err) {
    throw new Error(`fixture not found: ${id} (looked in ${dir})`);
  }
  const manifestPath = path.join(dir, 'manifest.yaml');
  try {
    await fs.access(manifestPath);
  } catch {
    throw new Error(`fixture ${id} is missing manifest.yaml`);
  }
  return dir;
}

function validateManifest(id: string, raw: unknown): FixtureManifest {
  if (raw === null || typeof raw !== 'object') {
    throw new Error(`fixture ${id}: manifest.yaml must parse to an object`);
  }
  const m = raw as Record<string, unknown>;
  const expectFiles = m.expectedFiles;
  if (!Array.isArray(expectFiles) || expectFiles.some((f) => typeof f !== 'string')) {
    throw new Error(`fixture ${id}: expectedFiles must be a string[]`);
  }
  const tolerancesRaw = m.tolerances as Record<string, unknown> | undefined;
  const tolerances: FixtureTolerances = {
    ignoreLocalRenames: Boolean(tolerancesRaw?.ignoreLocalRenames),
    ignoreWhitespaceOnly: Boolean(tolerancesRaw?.ignoreWhitespaceOnly),
  };
  const required = ['id', 'description', 'intent', 'language', 'runtime'] as const;
  for (const k of required) {
    if (typeof m[k] !== 'string' || !(m[k] as string).trim()) {
      throw new Error(`fixture ${id}: manifest.${k} must be a non-empty string`);
    }
  }
  if (m.id !== id) {
    throw new Error(`fixture ${id}: manifest.id (${String(m.id)}) does not match directory name`);
  }
  return {
    id: m.id as string,
    description: m.description as string,
    intent: m.intent as string,
    language: m.language as string,
    runtime: m.runtime as string,
    expectedFiles: expectFiles as string[],
    tolerances,
    ...(typeof m.notes === 'string' ? { notes: m.notes } : {}),
  };
}

/**
 * List every fixture id under the fixtures root. Used by the CLI's
 * default "all fixtures" mode and by the conformance test.
 */
export async function listFixtures(): Promise<string[]> {
  const root = fixturesRoot();
  const entries = await fs.readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .filter((name) => !name.startsWith('.'))
    .sort();
}

/**
 * Copy a fixture's source tree into a fresh tempdir and return the
 * manifest + paths. The runner uses this to give the agent a clean
 * isolated workspace per case.
 *
 * The fixture's `expected.diff` is left in the original location and
 * referenced by path so the runner can use it without copying.
 */
export async function loadFixture(id: string): Promise<LoadedFixture> {
  const dir = await resolveFixtureDir(id);
  const manifestRaw = await fs.readFile(path.join(dir, 'manifest.yaml'), 'utf8');
  const manifest = validateManifest(id, parseYaml(manifestRaw));

  const tmpRoot = await fs.mkdtemp(path.join(await tempBase(), `mc-eval-${id}-`));
  await copyTree(dir, tmpRoot, ['manifest.yaml', 'expected.diff']);

  const expectedDiffPath = path.join(dir, 'expected.diff');
  try {
    await fs.access(expectedDiffPath);
  } catch {
    throw new Error(`fixture ${id}: expected.diff is required at ${expectedDiffPath}`);
  }
  return { manifest, workspacePath: tmpRoot, expectedDiffPath };
}

async function tempBase(): Promise<string> {
  return process.env.MERGECREW_EVAL_TMP_BASE ?? (await defaultTmp());
}

async function defaultTmp(): Promise<string> {
  const os = await import('node:os');
  return os.tmpdir();
}

/**
 * Recursive directory copy, skipping a top-level exclude list. The
 * fixture's manifest + expected.diff stay in the source tree and are
 * referenced directly — there's no need to ship them into the agent's
 * workspace.
 */
async function copyTree(from: string, to: string, excludeTop: string[]): Promise<void> {
  const entries = await fs.readdir(from, { withFileTypes: true });
  await fs.mkdir(to, { recursive: true });
  for (const e of entries) {
    if (excludeTop.includes(e.name)) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) {
      await copyTree(src, dst, []);
    } else if (e.isFile()) {
      await fs.copyFile(src, dst);
    }
  }
}
