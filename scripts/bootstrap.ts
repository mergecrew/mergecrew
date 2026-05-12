/* eslint-disable no-console */
/**
 * One-command first-run setup (#316). Idempotent. Run with:
 *
 *   pnpm bootstrap                       # uses defaults
 *   pnpm bootstrap --email me@host       # custom admin email
 *   pnpm bootstrap --non-interactive     # skip telemetry prompt
 *
 * Steps:
 *   1. Ensure .env exists. If it doesn't, copy .env.example and replace
 *      every `change-me-in-prod` and stub-secret value with a fresh
 *      cryptographically random one. Never overwrites an existing .env.
 *   2. Run `prisma migrate deploy` against DATABASE_URL.
 *   3. Run the existing db seed (covers price table, demo org, demo user,
 *      demo project, minimal lifecycle).
 *   4. Upsert a default Ollama LLM profile + provider on the demo org so
 *      the user lands on a working setup.
 *   5. Print a 4-line summary: org URL, admin email, magic-link URL,
 *      what to do next.
 */

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { resolve } from 'node:path';
import dotenv from 'dotenv';

interface Args {
  email: string;
  nonInteractive: boolean;
}

const REPO_ROOT = resolve(__dirname, '..');
const ENV_PATH = resolve(REPO_ROOT, '.env');
const ENV_EXAMPLE_PATH = resolve(REPO_ROOT, '.env.example');

function parseArgs(argv: string[]): Args {
  const out: Args = { email: 'demo@mergecrew.local', nonInteractive: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--email') {
      const v = argv[++i];
      if (!v) throw new Error('--email requires a value');
      out.email = v;
    } else if (a === '--non-interactive') {
      out.nonInteractive = true;
    }
  }
  return out;
}

function log(line: string): void {
  console.log(line);
}

function logSection(title: string): void {
  console.log(`\n→ ${title}`);
}

function ensureEnv(): { created: boolean } {
  if (existsSync(ENV_PATH)) {
    log('  .env exists — keeping current values');
    return { created: false };
  }
  if (!existsSync(ENV_EXAMPLE_PATH)) {
    throw new Error(`.env.example missing at ${ENV_EXAMPLE_PATH}`);
  }
  copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
  // Replace placeholder secrets with cryptographically random values.
  // `change-me-in-prod` is the canonical placeholder used in .env.example.
  let content = readFileSync(ENV_PATH, 'utf8');
  content = content.replace(/^JWT_SECRET=.*$/m, `JWT_SECRET=${randomToken(32)}`);
  content = content.replace(/^NEXTAUTH_SECRET=.*$/m, `NEXTAUTH_SECRET=${randomToken(32)}`);
  content = content.replace(/^BFF_TRUST_TOKEN=.*$/m, `BFF_TRUST_TOKEN=${randomToken(24)}`);
  // KMS_MASTER_KEY isn't in .env.example today — append a fresh one so
  // dev-only credential encryption works without further setup. Format
  // matches the prod-style `base64:<32 bytes>`.
  if (!/^KMS_MASTER_KEY=/m.test(content)) {
    content += `\nKMS_MASTER_KEY=base64:${randomBytes(32).toString('base64')}\n`;
  }
  writeFileSync(ENV_PATH, content);
  log('  .env created with fresh random secrets');
  return { created: true };
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const r = spawnSync(cmd, args, { cwd: REPO_ROOT, stdio: 'inherit', env });
  if (r.status !== 0) {
    throw new Error(`command failed: ${cmd} ${args.join(' ')}`);
  }
}

function runMigrations(): void {
  // Use the root db:migrate script — it loads .env via dotenv-cli so
  // DATABASE_URL + DATABASE_MIGRATE_URL resolve correctly even when the
  // operator's shell has none of those exported.
  run('pnpm', ['db:migrate']);
}

function runSeed(email: string): void {
  // Override demo user email if the operator passed --email. dotenv-cli
  // (inside db:seed) won't clobber env vars that are already set in
  // process.env, so this override survives through to the seed script.
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MERGECREW_DEV_USER_EMAIL: email,
  };
  run('pnpm', ['db:seed'], env);
}

async function upsertDefaultLlmProfile(): Promise<void> {
  // Lazy import: the @prisma/client binary may not exist before migrate
  // runs, and bootstrap is the only consumer of this code path. Keeping
  // the import here means a fresh checkout's `pnpm bootstrap` doesn't
  // crash on first parse.
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const org = await prisma.organization.findUnique({ where: { slug: 'demo' } });
    if (!org) {
      log('  demo org not found — skipping LLM profile (seed must have failed)');
      return;
    }
    // Provider: Ollama, pointing at the compose-stack hostname when running
    // inside compose, else the localhost default. The actual runtime resolves
    // this per LlmProvider row, not from env, so we just pick the sensible
    // default for the local-stack quickstart path.
    const endpoint = process.env.OLLAMA_URL ?? 'http://localhost:11434';
    const provider = await prisma.llmProvider.findFirst({
      where: { organizationId: org.id, kind: 'ollama' },
    });
    const providerId = provider
      ? provider.id
      : (
          await prisma.llmProvider.create({
            data: {
              organizationId: org.id,
              kind: 'ollama',
              label: 'Local Ollama',
              endpoint,
            },
          })
        ).id;
    const existing = await prisma.llmProfile.findUnique({
      where: { organizationId_name: { organizationId: org.id, name: 'default' } },
    });
    if (!existing) {
      await prisma.llmProfile.create({
        data: {
          organizationId: org.id,
          name: 'default',
          preferenceOrder: [{ providerId, modelId: 'llama3.2:3b' }],
          capabilityRouting: {},
        },
      });
      log('  default Ollama LLM profile created');
    } else {
      log('  default LLM profile already exists — keeping it');
    }
  } finally {
    await prisma.$disconnect();
  }
}

function printSummary(args: Args): void {
  const webUrl = process.env.WEB_BASE_URL ?? 'http://localhost:3000';
  console.log('\n────────────────────────────────────────────────────────────');
  console.log('  Bootstrap complete.');
  console.log('');
  console.log(`  Org URL:        ${webUrl}/orgs/demo`);
  console.log(`  Admin email:    ${args.email}`);
  console.log(`  Magic-link:     ${webUrl}/  (auto-login enabled in dev)`);
  console.log(`  Next:           start the stack with \`pnpm compose:full\``);
  console.log('────────────────────────────────────────────────────────────');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  logSection('Checking .env');
  ensureEnv();

  // Load the freshly-written (or pre-existing) .env into this process so
  // step 4's Prisma connection picks up DATABASE_URL without relying on
  // the shell having exported it. dotenv preserves anything already in
  // process.env (the `override: false` default).
  dotenv.config({ path: ENV_PATH });

  logSection('Generating Prisma client');
  run('pnpm', ['db:generate']);

  logSection('Applying database migrations');
  runMigrations();

  logSection('Seeding demo org + user');
  runSeed(args.email);

  logSection('Configuring default LLM profile');
  await upsertDefaultLlmProfile();

  printSummary(args);
}

main().catch((err) => {
  console.error('\nbootstrap: fatal', err);
  process.exit(1);
});
