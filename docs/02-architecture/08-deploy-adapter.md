# Deploy adapter

Deploys are pluggable. The current implementations are **GitHub Actions** (the bridge to existing AWS pipelines) at `packages/adapters-deploy/src/github-actions.ts` and **Vercel** (the opinionated default for new in-app projects) at `packages/adapters-deploy/src/vercel.ts`.

## Interface

The interface lives in `packages/adapters-deploy/src/types.ts`:

```ts
interface DeployProvider {
  readonly id: 'github-actions' | 'vercel';

  // Triggering
  triggerDeploy(target: DeployTargetRef, opts: DeployOpts): Promise<DeployHandle>;

  // Polling / waiting
  getStatus(handle: DeployHandle): Promise<DeployStatus>;
  awaitCompletion(handle: DeployHandle, timeoutMs: number, abort: AbortSignal): Promise<DeployResult>;

  // URL & logs
  resolveUrlForRef(target: DeployTargetRef, ref: string): Promise<string | null>;
  fetchLogs(handle: DeployHandle, opts: { sinceMs?: number; tailLines?: number }): Promise<LogChunk[]>;

  // Production rollback
  rollbackProduction(target: DeployTargetRef, toRef: string): Promise<DeployHandle>;
}

type DeployOpts = {
  ref: string;                              // commit SHA
  branch: string;                           // for branch-based providers
  envOverrides?: Record<string, string>;    // optional, scoped
  correlationId: string;                    // for idempotent retry
};

type DeployStatus =
  | { kind: 'queued' }
  | { kind: 'in_progress'; pct?: number; latestStep?: string }
  | { kind: 'success'; url: string; finishedAt: string }
  | { kind: 'failed'; reason: string; url?: string; finishedAt: string }
  | { kind: 'cancelled' };
```

> Six adapters ship in `packages/adapters-deploy/src/`: `github-actions`, `vercel`, `netlify`, `render`, `fly`, `railway`, and `aws-direct`. See [`06-deploy-targets-cookbook.md`](../03-infrastructure/06-deploy-targets-cookbook.md) for copy-paste configs and per-adapter capability details.

## Adapter 1 — GitHub Actions (the AWS bridge)

This is the adapter that lets Mergecrew work with the user's existing AWS + GitHub Actions pipeline without rewriting it.

### Configuration

Per `DeployTarget`:

```yaml
deploy_targets:
  dev:
    adapter: github-actions
    workflow_filename: .github/workflows/deploy-dev.yml
    inputs_template:
      branch: "${ref.branch}"
      environment: "dev"
    url_resolution: workflow_output       # or 'pattern' or 'fixed'
    url_pattern: "https://${ref.branch}.dev.acme.io"  # if url_resolution=pattern
  prod:
    adapter: github-actions
    workflow_filename: .github/workflows/deploy-prod.yml
    inputs_template:
      ref: "${ref.sha}"
      environment: "prod"
    url_resolution: fixed
    url_fixed: "https://app.acme.io"
```

### How a deploy works

1. `triggerDeploy()` calls GitHub `POST /repos/{owner}/{repo}/actions/workflows/{workflow_filename}/dispatches` with `ref` (the branch) and `inputs` (rendered from the template).
2. There is no direct mapping from `dispatch` → run id. The adapter then polls `GET /repos/.../actions/runs?event=workflow_dispatch&branch={branch}` filtering by start time to find the run that was just kicked off. To make this robust, the adapter:
   - Includes `correlationId` as one of the `inputs` (the user's workflow YAML must accept it and echo it as a step name; this is part of Mergecrew's workflow recipe).
   - Lists recent runs and matches by `correlationId`.
3. Once the run is identified, `getStatus()` polls `GET /repos/.../actions/runs/{run_id}` every 5–15s with backoff.
4. `awaitCompletion()` blocks until the run finishes or the timeout elapses.
5. URL resolution:
   - `workflow_output`: read the workflow run's job outputs (requires the user to expose `dev_url` as an output).
   - `pattern`: substitute branch/ref into a template URL.
   - `fixed`: a constant URL.
6. On failure, `fetchLogs()` pulls the failed job's logs (truncated; a link to GitHub for full logs).

### Bootstrap / Inception cooperation

When connecting an existing repo, Project Inception detects existing `.github/workflows/*.yml`. If a workflow looks like a deploy:

- Mergecrew proposes the workflow filename.
- Mergecrew checks whether the workflow accepts a `correlationId` input. If not, it suggests a small PR to add it.
- Mergecrew generates an "inputs template" by inspecting the workflow's `on.workflow_dispatch.inputs`.

The user reviews and approves before the adapter is finalized.

### Idempotency

`correlationId` makes deploys idempotent: re-triggering the same correlation id while a previous run is still in progress returns that run's handle instead of starting a new one. This survives orchestrator crashes.

### Logs

The adapter does not stream every line of logs into the timeline (that would be noisy). It pulls only:
- The first 50 lines after a failure (the typical "what broke" preamble).
- The last 50 lines (where the failure usually is).
- A link to the full logs in GitHub.

## Adapter 2 — Vercel (the opinionated default for greenfield)

When Mergecrew scaffolds a new project, the default deploy is Vercel for the Next.js front-end and either:
- Vercel Functions for the NestJS back-end (if the back-end fits in serverless), or
- One of the long-running container adapters: `render`, `fly`, `railway`, or `aws-direct`. The cookbook has the relevant config shapes.

For greenfield: Vercel for everything, with a managed Postgres (Neon).

### Configuration

```yaml
deploy_targets:
  dev:
    adapter: vercel
    project_id: prj_aBcDe...
    target: preview
  prod:
    adapter: vercel
    project_id: prj_aBcDe...
    target: production
```

### How it works

- `triggerDeploy()` → `POST /v13/deployments` with `{ gitSource: { type: 'github', repoId, ref } }`.
- `getStatus()` → `GET /v13/deployments/{id}`.
- URL is in the deployment response.
- `rollbackProduction()` → promote a previous deployment via Vercel's Promote API.

### Branch → Preview URL mapping

For `dev`, the URL is the Vercel preview URL for the changeset's branch. Mergecrew stores this on the Changeset.

## Production rollback model

Mergecrew does **not** redeploy a rollback by re-running the user's "deploy-prod" workflow with an old SHA. That mode of rollback couples to assumptions about the workflow being idempotent for old refs. Instead:

- **GitHub Actions adapter.** Mergecrew opens a revert PR for the changeset's merged commit, triggers `deploy-prod` with the new HEAD SHA. The user sees this as a new deploy with the revert.
- **Vercel adapter.** Mergecrew calls Vercel's Promote API to point production at the previous successful deployment. Then opens a revert PR so git history reflects reality. The two are coordinated; if either fails, Mergecrew holds and surfaces an "incident" gate.

Both modes preserve the invariant that **production state matches `main` HEAD**. The user doesn't end up in a state where prod is running code that isn't on main.

## Multi-target deploys

A project can have multiple non-prod targets (dev, staging). Changesets are deployed to dev by default. Promotion can target prod directly or stage through staging-then-prod (configurable per project; default direct dev → prod).

## Adapter authoring rules

When a new adapter is added, it must:
- Implement the full `DeployProvider` interface.
- Be idempotent on retried `triggerDeploy()` for the same `correlationId`.
- Surface a typed `DeployStatus` (no string-shaped statuses).
- Provide `rollbackProduction` semantics that maintain the prod=main invariant.
- Pass a conformance test suite (`packages/adapters-deploy/test/conformance.ts`).

## Error classes the orchestrator handles

- `transient` — adapter is temporarily unavailable. Retried with backoff.
- `auth` — credentials invalid. Run paused; user notified to repair.
- `config` — adapter config (workflow filename, project id) wrong. Surfaced to the user; run fails for that target.
- `runtime_failure` — deploy ran and failed (e.g., a build error). Captured as a `CHANGESET_TESTS_FAILED`-equivalent event on the changeset; QA agent revisits.

## Logging & observability per deploy

Each deploy produces a `Deploy` record:

```ts
type Deploy = {
  id: string;
  organizationId: string;
  projectId: string;
  changesetId?: string;       // null for prod-rollback-only deploys
  targetId: 'dev'|'staging'|'prod';
  adapterId: string;
  ref: string;
  correlationId: string;
  externalRunId?: string;     // GitHub Actions run id, Vercel deployment id, …
  url?: string;
  startedAt: Date;
  finishedAt?: Date;
  status: DeployStatus;
};
```

Linked to TimelineEvents (`CHANGESET_DEV_DEPLOYED`, etc.).

## Adding a new adapter

A new vendor adapter (Fly.io, Railway, AWS-direct, …) needs three things:

1. **An implementation of `DeployProvider`** in `packages/adapters-deploy/src/<vendor>.ts`. The interface lives in `types.ts`. Five existing adapters (`github-actions`, `vercel`, `netlify`, `render`) are reference implementations.
2. **The new adapter id added to the `DeployProvider.id` union** in `types.ts`. The runner picks adapters by id (`apps/runner/src/step.ts:204-215`); the type gate keeps that switch exhaustive.
3. **A conformance test** in `packages/adapters-deploy/test/<vendor>.test.ts`. Use `test/render.test.ts` as the template — copy the file, swap the fetch mocks for your vendor's HTTP shape, and the helpers in `test/conformance.ts` will catch contract violations:
   - `triggerDeploy` returns a well-shaped `DeployHandle`.
   - `getStatus` returns a `DeployStatus` with one of the five valid `kind`s.
   - `awaitCompletion` bounds total runtime by `timeoutMs` even when the deploy never reaches a terminal state.
   - `resolveUrlForRef` returns either a string URL or null.
   - `fetchLogs` returns an array (empty is fine if the vendor doesn't expose logs via API).
   - `rollbackProduction` returns a well-shaped `DeployHandle`.
   - Non-2xx HTTP responses propagate as a thrown error.

The conformance helpers stub global `fetch` per test, so adapters that go through the standard `fetch` path are testable without mocking the entire HTTP layer. Adapters that wrap an SDK (e.g., `@octokit/rest` for GitHub Actions) need to mock at the SDK seam instead — same set of contract assertions.

Once the test passes, run `pnpm --filter @mergecrew/adapters-deploy test` locally and CI picks up the rest.
