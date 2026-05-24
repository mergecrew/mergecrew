#!/usr/bin/env node
import os from 'node:os';
import { logger } from './logger.js';
import {
  resolveAgentConfig,
  tokenPrefix,
  assertConfigUsable,
  type AgentConfig,
} from './config.js';

/**
 * `mergecrew/runner-agent` CLI entry (V2.af / #764).
 *
 * This release ships the skeleton only: arg parsing, config resolution,
 * and a `--dry-run` mode that prints the resolved config and exits 0.
 * The HTTP integration (long-poll loop, job execution) lands in #766.
 *
 * Usage:
 *   docker run mergecrew/runner-agent \
 *     --token mca_acme_XXXXXXXXXXXXXXXXXXXXXXXXXX \
 *     --api-url https://mergecrew.dev \
 *     --name homelab-1 \
 *     --driver docker
 */
function printHelp(): void {
  process.stdout.write(
    [
      'mergecrew/runner-agent — BYO runner agent (skeleton)',
      '',
      'Usage:',
      '  mergecrew-runner-agent --token <bearer> --api-url <url> [options]',
      '',
      'Options:',
      '  --token <bearer>       Enrollment bearer (or MERGECREW_AGENT_TOKEN).',
      '  --api-url <url>        Mergecrew API base URL (or MERGECREW_API_URL).',
      '  --name <name>          Display name in the org settings (default: hostname).',
      '  --driver <kind>        process | docker (default: docker).',
      '  --concurrency <n>      Parallel jobs to process (default: 1).',
      '  --dry-run              Print resolved config and exit.',
      '  --help                 Show this message.',
      '',
      'This is the skeleton release: --dry-run is the only supported mode.',
      'Job pull + execution lands in #766.',
      '',
    ].join('\n'),
  );
}

function printConfig(cfg: AgentConfig): void {
  // Use a plain console line rather than the pino logger so the dry-run
  // output stays human-friendly even with `LOG_LEVEL=info`. The
  // structured logger still gets the same payload one line down for
  // anyone consuming JSON logs.
  process.stdout.write('\n');
  process.stdout.write('Resolved runner-agent config:\n');
  process.stdout.write(`  name        : ${cfg.name}\n`);
  process.stdout.write(`  apiUrl      : ${cfg.apiUrl || '<unset>'}\n`);
  process.stdout.write(`  token       : ${tokenPrefix(cfg.token)}\n`);
  process.stdout.write(`  driver      : ${cfg.driver}\n`);
  process.stdout.write(`  concurrency : ${cfg.concurrency}\n`);
  process.stdout.write('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  let cfg: AgentConfig;
  try {
    cfg = resolveAgentConfig({
      argv,
      env: process.env,
      hostname: () => os.hostname(),
    });
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'config error');
    process.exit(2);
  }

  if (cfg.dryRun) {
    logger.info(
      {
        name: cfg.name,
        apiUrl: cfg.apiUrl || null,
        tokenPrefix: tokenPrefix(cfg.token),
        driver: cfg.driver,
        concurrency: cfg.concurrency,
      },
      'runner-agent dry-run',
    );
    printConfig(cfg);
    process.exit(0);
  }

  try {
    assertConfigUsable(cfg);
  } catch (err) {
    logger.error({ err: err instanceof Error ? err.message : err }, 'config error');
    process.exit(2);
  }

  // #766 will replace this with the long-poll loop. For #764 the
  // agent intentionally fails fast in non-dry-run mode so an operator
  // who runs an old image against a deployment that expects #766
  // sees a clear "not yet implemented" rather than a silent hang.
  logger.error(
    'runner-agent skeleton: job pull is not implemented yet (lands in #766). Run with --dry-run to validate config.',
  );
  process.exit(3);
}

main().catch((err) => {
  logger.error({ err: err instanceof Error ? err.message : err }, 'unhandled error');
  process.exit(1);
});
