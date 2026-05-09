import type { Logger } from 'pino';
import { withTenant } from '@mergecrew/db';
import { parseMergecrewYaml, mergeWithDefault } from '@mergecrew/config-yaml';
import { GitHubProvider } from '@mergecrew/adapters-vcs';

const CONFIG_PATH = 'mergecrew.yaml';

type SyncOutcome =
  | { synced: false; reason: string }
  | { synced: true; version: number };

/**
 * Pull `mergecrew.yaml` from the project's connected repo at run-start and
 * persist it as a new Lifecycle version when it differs from the last
 * snapshot. The merged form (default ⊕ project) is what's stored, so the
 * orchestrator and runner only ever read a fully-resolved config.
 *
 * Skipped silently when:
 *   - the project has no connected repo (manual / pre-onboarding runs)
 *   - the GitHub App env isn't configured (dev without OAuth)
 *   - the file is missing in the repo (project hasn't opted in)
 *   - the yaml hasn't changed since the last persisted version
 *
 * Parse failures are logged but non-fatal — the run continues with whatever
 * lifecycle version is already in the DB.
 */
export async function syncLifecycleFromRepo(opts: {
  organizationId: string;
  projectId: string;
  logger: Logger;
}): Promise<SyncOutcome> {
  const { organizationId, projectId, logger } = opts;

  if (!process.env.GITHUB_APP_ID || !process.env.GITHUB_APP_PRIVATE_KEY) {
    return { synced: false, reason: 'github-app-not-configured' };
  }

  const repo = await withTenant(organizationId, (tx) =>
    tx.connectedRepo.findUnique({ where: { projectId } }),
  );
  if (!repo) return { synced: false, reason: 'no-connected-repo' };

  const vcs = new GitHubProvider({
    appId: process.env.GITHUB_APP_ID,
    privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
  });

  let yaml: string;
  try {
    const file = await vcs.getFileAt(
      {
        installationId: repo.installationId,
        repoId: repo.repoId ?? undefined,
        repoFullName: repo.repoFullName,
        defaultBranch: repo.defaultBranch,
      },
      repo.defaultBranch,
      CONFIG_PATH,
    );
    yaml = Buffer.from(file.contentBase64, 'base64').toString('utf-8');
  } catch (e: any) {
    logger.debug({ err: e?.message ?? e }, 'lifecycle-sync: mergecrew.yaml not in repo');
    return { synced: false, reason: 'no-yaml-in-repo' };
  }

  const last = await withTenant(organizationId, (tx) =>
    tx.lifecycle.findFirst({ where: { projectId }, orderBy: { version: 'desc' } }),
  );
  if (last?.sourceYaml === yaml) {
    return { synced: false, reason: 'unchanged' };
  }

  let merged;
  try {
    const { parsed } = parseMergecrewYaml(yaml);
    merged = mergeWithDefault(parsed);
  } catch (e: any) {
    logger.warn(
      { projectId, err: e?.message ?? e },
      'lifecycle-sync: mergecrew.yaml in repo failed to parse; keeping last DB version',
    );
    return { synced: false, reason: 'parse-failed' };
  }

  const nextVersion = (last?.version ?? 0) + 1;
  const created = await withTenant(organizationId, (tx) =>
    tx.lifecycle.create({
      data: {
        organizationId,
        projectId,
        version: nextVersion,
        sourceYaml: yaml,
        parsed: merged as any,
      },
    }),
  );
  logger.info(
    { projectId, version: nextVersion, lifecycleId: created.id },
    'lifecycle-sync: pulled new mergecrew.yaml from repo',
  );
  return { synced: true, version: nextVersion };
}

