# Deploy-target configuration cookbook

Concrete configs for the patterns most operators actually run, so wiring Mergecrew against an existing repo is copy-paste rather than read-the-source.

Each pattern below is one section with:
- **Shape** — what the operator's existing CI looks like.
- **DeployTarget config** — paste into the `config` jsonb on `deploy_targets` (or fill in via Settings → Deploy targets in the UI).
- **What the agent does** — when it dispatches vs. observes, where the URL comes from, what stays human-gated.
- **Required permissions** — the minimum GitHub App + provider scopes.

If you want the underlying interface contract instead of recipes, see [`packages/adapters-deploy/src/types.ts`](../../packages/adapters-deploy/src/types.ts) and the per-adapter source files linked from each section.

## Pick your shape

```
What kicks your existing dev deploy today?
│
├─ Already wired up — I just need mergecrew to know the URL  ─►  Pattern 0 (external-ci)
│
├─ A push to main (your CI fires automatically)
│  ├─ Vercel project? ─────────────────────►  Pattern 1
│  ├─ Netlify site?   ─────────────────────►  Pattern 2
│  └─ Anything else (ECS, k8s, Fly, …)  ───►  Pattern 3 (github-actions observe)
│
├─ A manual button (workflow_dispatch / CD UI / etc.)
│  ├─ A workflow you wrote in GitHub Actions  ─►  Pattern 4 (github-actions dispatch)
│  ├─ Fly machines API ──────────────────────►  Pattern 6a
│  ├─ Render deploy hook ────────────────────►  Pattern 6b
│  └─ Railway CLI ───────────────────────────►  Pattern 6c
│
└─ A direct AWS SDK call (no CI in the middle)
   ├─ Lambda            ─►  Pattern 5a
   ├─ ECS rolling update ─►  Pattern 5b
   └─ S3 + CloudFront    ─►  Pattern 5c
```

Mix and match across environments. A common shape: Pattern 3 for dev, Pattern 4 for prod (auto-deploy on PR merge to main; require a human to click the prod button).

## Pattern 0 — External CI/CD (the wizard default)

**Shape.** You already have CI/CD building and deploying your app on merge to your base branch — GitHub Actions, GitLab CI, Buildkite, Jenkins, Argo, anything. The pipeline publishes to a stable URL like `https://dev.example.com`. You don't want mergecrew to dispatch builds; you just need it to know where the build will be reachable so downstream skills (smoke checks, screenshot diffs) can target it.

**DeployTarget config.**

```jsonc
{
  "kind": "dev",
  "adapterId": "external-ci",
  "config": {
    "urlFixed": "https://dev.example.com"
  }
}
```

For per-branch preview hosts, swap `urlFixed` for `urlPattern` with `${branch}` / `${sha}` placeholders:

```jsonc
{
  "config": {
    "urlPattern": "https://${branch}.preview.example.com"
  }
}
```

**Provider auth.** None. The adapter makes no outbound HTTP calls.

**What the agent does.** Nothing on the deploy side. `triggerDeploy` returns success immediately; `resolveUrlForRef` interpolates the configured URL. The assumption is that by the time downstream skills need the URL, the user's existing pipeline has already raced ahead. Teams that need stricter sequencing — mergecrew waiting until the deploy is actually live before running a smoke check — should use **Pattern 3** (`github-actions observe`) instead.

**GitHub App scopes.** Contents:read/write, Pull requests:read/write. No Actions scope needed.

This is the adapter the inline onboarding wizard defaults to (#467). It's the fastest path to a green wizard for anyone whose CI/CD is already configured outside mergecrew. Switch to a richer adapter from project settings later if you need lifecycle observation, dispatch, or rollback support.

Source: [`packages/adapters-deploy/src/external-ci.ts`](../../packages/adapters-deploy/src/external-ci.ts).

## Pattern 1 — Vercel preview deploys

**Shape.** You've imported the repo into Vercel. Every PR gets a preview URL automatically; `main` becomes the production deployment. You don't write deploy workflows in `.github/workflows/`.

**DeployTarget configs.**

```jsonc
// dev — what the agent sees on every PR
{
  "kind": "dev",
  "adapterId": "vercel",
  "config": {
    "projectId": "prj_XXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "teamId":    "team_XXXXXXXXXXXXXXXXXXXX",  // omit for personal accounts
    "target":    "preview",
    "repoSlug":  "acme/web"
  }
}
```

```jsonc
// prod — only fires when a human promotes from the digest
{
  "kind": "prod",
  "adapterId": "vercel",
  "config": {
    "projectId": "prj_XXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    "teamId":    "team_XXXXXXXXXXXXXXXXXXXX",
    "target":    "production",
    "repoSlug":  "acme/web"
  }
}
```

**Provider auth.** A Vercel personal/team access token in the org secret `VERCEL_TOKEN`. Settings → Integrations → Provider tokens (or `INSERT INTO organization_secrets …` if you script it).

**What the agent does.** No dispatch — the Vercel adapter polls Vercel's REST API for the existing deployment on the agent-pushed branch and reads the preview URL when it lands.

**GitHub App scopes.** Contents:read/write, Pull requests:read/write. No Actions scope needed.

Source: [`packages/adapters-deploy/src/vercel.ts`](../../packages/adapters-deploy/src/vercel.ts).

## Pattern 2 — Netlify

**Shape.** Site connected to GitHub; every push to a branch builds; `main` (or whichever production branch) becomes the live site.

**DeployTarget configs.**

```jsonc
// dev
{
  "kind": "dev",
  "adapterId": "netlify",
  "config": { "siteId": "12345678-aaaa-bbbb-cccc-dddddddddddd" }
}
```

```jsonc
// prod — same site id; the prod gate is enforced by the human approval, not by a different Netlify site
{
  "kind": "prod",
  "adapterId": "netlify",
  "config": { "siteId": "12345678-aaaa-bbbb-cccc-dddddddddddd" }
}
```

Netlify's `siteId` is the API identifier (UUID), not the user-facing slug. You can find it under Site overview → Site information.

**Provider auth.** A Netlify personal access token in the org secret `NETLIFY_TOKEN`.

**What the agent does.** Kicks `POST /sites/:id/builds` and polls deploy status. Netlify's GitHub connection decides which branch builds; the adapter doesn't override.

Source: [`packages/adapters-deploy/src/netlify.ts`](../../packages/adapters-deploy/src/netlify.ts).

## Pattern 3 — github-actions observe (the AWS ECS Fargate pattern)

**Shape.** You already have `.github/workflows/deploy-dev.yml` (or any name) wired to fire on `push` to main / on PR merge / on a branch pattern. Merging is the trigger; the workflow runs `aws ecs update-service` or whatever. You **don't** want Mergecrew to also call `workflowDispatch` — that would duplicate the deploy.

**DeployTarget config.**

```jsonc
{
  "kind": "dev",
  "adapterId": "github-actions",
  "config": {
    "installationId":    "12345678",
    "repoFullName":      "acme/saas-app",
    "workflowFilename":  "deploy-dev.yml",
    "triggerMode":       "observe",                     // ← key field
    "observeFindTimeoutMs": 60000,                       // optional; default 60s
    "urlResolution":     "pattern",
    "urlPattern":        "https://${branch}.preview.acme.dev"
  }
}
```

For prod, use a separate target in dispatch mode (next section) so the agent only kicks prod when a human promotes from the digest.

**What the agent does.** The agent pushes the PR branch via the GitHub App. Your CI fires on push as it normally would. Mergecrew's SRE step calls `triggerDeploy` which **doesn't dispatch** — it polls `actions.listWorkflowRuns` filtered to the agent-pushed branch + your workflow filename, picks up the run id, watches it to terminal, and posts the resolved URL back as a PR comment. If your CI doesn't produce a run within `observeFindTimeoutMs`, Mergecrew fails with a clear "no_triggered_run" reason — better than hanging.

**URL resolution choices.**
- `urlResolution: "pattern"` — for repos where each branch maps to a deterministic URL (per-branch preview environments).
- `urlResolution: "fixed"` — for repos with a single dev URL all PRs land on (`urlFixed: "https://dev.acme.dev"`).
- `urlResolution: "workflow_output"` — for workflows that expose a `deploy-url` step output. Read by `awaitCompletion`.

**Required permissions.** Mergecrew GitHub App on the repo with:
- `Contents: Read & Write` — to clone, push branches, commit.
- `Pull requests: Read & Write` — to open and comment on PRs.
- `Actions: Read` — to read the existing workflow run.

No Actions write needed in observe mode; we never dispatch.

Source: [`packages/adapters-deploy/src/github-actions.ts`](../../packages/adapters-deploy/src/github-actions.ts).

## Pattern 4 — github-actions dispatch (the prod gate)

**Shape.** You want Mergecrew (or a human via the digest) to explicitly trigger the deploy — never on push. Standard pattern for production. The workflow uses `on: workflow_dispatch:`.

**DeployTarget config.**

```jsonc
{
  "kind": "prod",
  "adapterId": "github-actions",
  "config": {
    "installationId":   "12345678",
    "repoFullName":     "acme/saas-app",
    "workflowFilename": "deploy-prod.yml",
    "triggerMode":      "dispatch",                       // default, listed for clarity
    "inputsTemplate":   {
      "ref":         "${ref.sha}",
      "environment": "production"
    },
    "urlResolution":    "fixed",
    "urlFixed":         "https://app.acme.dev"
  }
}
```

`inputsTemplate` values are interpolated at trigger time. Available placeholders:
- `${ref.branch}` — the branch the agent built.
- `${ref.sha}` — the commit SHA.
- `${correlationId}` — Mergecrew's per-deploy correlation id, also forwarded as the `mergecrew_correlation_id` input so your workflow can echo it back.

**What the agent does.** The SRE step calls `workflowDispatch` on `deploy-prod.yml` with the rendered inputs, finds the resulting run by correlation id, polls to terminal, returns the result. Production promotion is **always human-initiated** — Mergecrew only fires this when an operator clicks promote in the digest UI. There's no auto-promote path that bypasses the human gate.

**Required permissions.** Same as Pattern 3 plus `Actions: Read & Write` so the App can dispatch.

## Pattern 5 — aws-direct (no CI in the middle)

The `aws-direct` adapter has three sub-modes. Pick one per target. Operators with role-based deploys pre-assume the role and pass the temporary credentials via env on the runner; the adapter does not manage STS itself.

**Provider auth.** Either set `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_SESSION_TOKEN` on the runner, or rely on the default credential chain (IMDS, shared config, SSO).

### 5a. Lambda

**Shape.** Your CI builds the zip and uploads it to S3. Mergecrew flips the function to point at the new key.

```jsonc
{
  "kind": "dev",
  "adapterId": "aws-direct",
  "config": {
    "mode":           "lambda",
    "region":         "us-east-1",
    "functionName":   "acme-api-dev",
    "s3Bucket":       "acme-deploys",
    "s3KeyTemplate":  "api/${ref}.zip",
    "alias":          "live",                  // optional — repoint alias after publish
    "publicUrl":      "https://api-dev.acme.dev"
  }
}
```

### 5b. ECS rolling update

**Shape.** Your CI builds and pushes an image to ECR. Mergecrew registers a new task def revision with the new image and calls `UpdateService` to roll it.

```jsonc
{
  "kind": "dev",
  "adapterId": "aws-direct",
  "config": {
    "mode":          "ecs",
    "region":        "us-east-1",
    "cluster":       "acme-prod",
    "service":       "acme-api-dev",
    "containerName": "api",
    "imageTemplate": "1234567890.dkr.ecr.us-east-1.amazonaws.com/acme-api:${ref}",
    "publicUrl":     "https://api-dev.acme.dev"
  }
}
```

### 5c. S3 + CloudFront

**Shape.** Static site. Your CI runs `aws s3 sync`; Mergecrew invalidates CloudFront so the new objects are served immediately.

```jsonc
{
  "kind": "dev",
  "adapterId": "aws-direct",
  "config": {
    "mode":               "cf-s3",
    "region":             "us-east-1",
    "distributionId":     "EXXXXXXXXXXXXX",
    "invalidationPaths":  ["/*"],
    "publicUrl":          "https://app-dev.acme.dev"
  }
}
```

Source: [`packages/adapters-deploy/src/aws-direct.ts`](../../packages/adapters-deploy/src/aws-direct.ts).

## Pattern 6 — Fly / Render / Railway

### 6a. Fly.io

**Shape.** Your CI builds and pushes a Docker image to Fly's registry. Mergecrew deploys it via the Machines API.

```jsonc
{
  "kind": "dev",
  "adapterId": "fly",
  "config": {
    "appName":       "acme-api-dev",
    "imageTemplate": "registry.fly.io/acme-api-dev:${sha}",   // ${sha} → opts.ref
    "region":        "iad",                                    // optional
    "publicUrl":     "https://acme-api-dev.fly.dev"            // optional override
  }
}
```

**Auth.** Fly personal access token (org-scoped) or a project deploy token in the org secret `FLY_TOKEN`.

Source: [`packages/adapters-deploy/src/fly.ts`](../../packages/adapters-deploy/src/fly.ts).

### 6b. Render

**Shape.** Service connected to GitHub in Render; build on every push. Mergecrew kicks the deploy and watches status.

```jsonc
{
  "kind": "dev",
  "adapterId": "render",
  "config": { "serviceId": "srv-abc123def456" }
}
```

**Auth.** API key from Render → Account Settings → API Keys in the org secret `RENDER_TOKEN`.

Source: [`packages/adapters-deploy/src/render.ts`](../../packages/adapters-deploy/src/render.ts).

### 6c. Railway

**Shape.** Project linked to GitHub; deploys per service. Mergecrew fires the deploy via Railway's GraphQL API.

```jsonc
{
  "kind": "dev",
  "adapterId": "railway",
  "config": {
    "projectId":      "01234567-89ab-cdef-0123-456789abcdef",
    "environmentId":  "01234567-89ab-cdef-0123-456789abcdef",
    "serviceId":      "01234567-89ab-cdef-0123-456789abcdef"
  }
}
```

**Auth.** Project access token (recommended for CI) or personal token in the org secret `RAILWAY_TOKEN`.

Source: [`packages/adapters-deploy/src/railway.ts`](../../packages/adapters-deploy/src/railway.ts).

## Promotion patterns

The patterns above describe how the **dev** target works: where merged PRs land, how mergecrew watches them. This section describes how the **human-approved subset of those dev changes graduates to prod** — the daily-digest "Promote" loop the product is built around.

The constraint that shapes everything here: **pick-and-choose**. Each morning the human reviews what landed on dev overnight, picks the subset that's ready, and ships only that subset. Anything not picked stays on dev (deferred to next cycle) or is explicitly dropped (mergecrew opens a revert PR on dev). Because prod ≠ "current dev," every pattern needs a **release branch** that mergecrew builds by cherry-picking the approved subset. The patterns below differ in *what triggers prod from that release branch*.

The wizard's step 4b is one click per pattern. Switch later from project settings.

### Shape picker

```
What triggers your prod deploy today?
│
├─ A push to my release branch fires CI    ─►  Pattern PA (auto_deploy, the wizard default)
├─ A manual workflow_dispatch in GitHub    ─►  Pattern PB (manual_workflow)
├─ A git tag (v1.2.3 / 2026-05-17.1)       ─►  Pattern PC (tag_driven)
├─ I don't have a prod yet (one env)       ─►  Pattern PE (single_env)
└─ I'll figure this out later              ─►  Pattern PD (deferred)
```

### Pattern PA — Release branch + auto-deploy

**Shape.** Your existing CI deploys to prod whenever a commit lands on your release branch (often `main`). Common with Vercel production deploys, Netlify production sites, "merge to main = ship" GitHub Actions workflows, Heroku auto-deploy, Render production services, and most "configure once, forget" managed pipelines.

**PromotionStrategy config.**

```jsonc
{
  "kind": "auto_deploy",
  "releaseBranch": "main",
  "prodUrl": "https://app.example.com"
}
```

`releaseBranch` defaults to the connected repo's base PR branch (#469 — `basePrBranch ?? defaultBranch`). For branch-per-env teams, this is typically a separate branch from the one mergecrew opens PRs against — e.g. PRs into `developer`, releases into `main`.

**What mergecrew does on promote.**

1. Clone a fresh worktree.
2. Branch off `releaseBranch` HEAD into `mergecrew/release-{ISO-date}-{shortSha}`.
3. Cherry-pick each approved changeset's merge commit in chronological order.
4. Push the release branch (or open a PR against `releaseBranch` if it's protected).

**What your CI does.** Whatever it already does on push. mergecrew doesn't dispatch anything — the existing pipeline picks up the new commit and ships.

**Required GitHub App scopes.** Contents:write, Pull requests:write. No Actions scope needed.

### Pattern PB — Release branch + manual workflow

**Shape.** Your CI has a gated "Deploy to prod" workflow — `workflow_dispatch` in GitHub Actions — that an engineer clicks to ship. Common when prod deploys are coordinated with a release manager, when feature flags need flipping in concert, or when prod runs through a non-CI tool (Argo, Spinnaker) triggered via a one-button workflow.

**PromotionStrategy config.**

```jsonc
{
  "kind": "manual_workflow",
  "releaseBranch": "main",
  "workflowFilename": "deploy-prod.yml",
  "envInputKey": "environment",
  "envInputValue": "prod",
  "prodUrl": "https://app.example.com"
}
```

The `envInput*` fields target the workflow's `inputs:` schema. If the workflow has `inputs: { environment: { … } }`, mergecrew dispatches with `{ environment: "prod" }`.

**What mergecrew does on promote.**

1. Build the release branch (same cherry-pick flow as Pattern PA).
2. Dispatch `workflowFilename` via GitHub's `POST /repos/:owner/:repo/actions/workflows/:file/dispatches`, passing `{ [envInputKey]: envInputValue }` and `ref: releaseBranch`.
3. Return the workflow run URL in the digest so the human can watch it green.

If the GitHub App doesn't have the Actions:write scope, mergecrew falls back to pushing the release branch and surfacing the dispatch URL — the human clicks Run in the GitHub UI.

**What your CI does.** Runs whatever the workflow file says — typically a kube apply / Argo sync / aws-cli deploy / Spinnaker trigger.

**Required GitHub App scopes.** Contents:write, Pull requests:write, Actions:write.

### Pattern PC — Tag-driven

**Shape.** Your CI deploys when a tag matching a pattern is pushed. Common with semantic versioning (`v1.2.3`), date-based releases (`2026-05-17.1`), or any pipeline that watches `on: push: tags:` and ignores branch pushes.

**PromotionStrategy config.**

```jsonc
{
  "kind": "tag_driven",
  "tagPattern": "v${YYYY-MM-DD}-${shortSha}",
  "prodUrl": "https://app.example.com"
}
```

The pattern supports `${YYYY-MM-DD}` (UTC date at promote time) and `${shortSha}` (first 7 chars of the release branch HEAD). A future enhancement might add `${counter}` for monotonic ordering across same-day promotes.

**What mergecrew does on promote.**

1. Build the release branch (same cherry-pick flow).
2. Interpolate the tag pattern. Create an annotated tag at the release branch HEAD.
3. Push the tag. The release branch may or may not be pushed depending on your team's convention (mergecrew pushes both by default; tagging without a corresponding branch ref is fragile).

**What your CI does.** Fires on tag push. The agent reads the tag at deploy time and ships whatever commit it points at.

**Required GitHub App scopes.** Contents:write (push tags), Pull requests:write.

### Pattern PE — Single environment

**Shape.** Your project has one environment. Pre-launch, pre-revenue, or any "merged to main = live" setup where the cost of constructing a separate prod hasn't paid for itself yet. The wizard's other patterns assume two distinct destinations and ask for a Prod URL you can't honestly fill in.

You still want the daily ritual: review what the agents shipped overnight, drop the ones that shouldn't have landed. But there's no graduation to perform — what's on dev IS what's live.

**PromotionStrategy config.**

```jsonc
{ "kind": "single_env" }
```

No fields. No release branch, no workflow filename, no tag pattern, no prod URL.

**What mergecrew does on promote.** Nothing on the git side. The Promote button is relabeled **"Mark reviewed"**. Clicking it:

1. Creates a `PromoteRun` with `status='completed'`, `releaseRef=null`.
2. Stamps `lastPromoteRunId` on the approved changesets so they leave the digest.
3. Writes an audit-log entry per accepted changeset (`changeset.accepted` action).

**What your CI does.** Whatever it already did on merge to your base branch. mergecrew didn't touch it.

**Drop.** Works exactly the same as every other pattern — opens a revert PR on your base branch via the GitHub App, marks the changeset hidden from future digests.

**Required GitHub App scopes.** Same as everywhere else — Contents:write + Pull requests:write for the drop path. Actions / Workflows scopes are unnecessary since mergecrew doesn't dispatch anything for this kind.

**Graduating later.** When you split envs, switch the strategy in **Settings → Promotion strategy** to one of PA / PB / PC. The accumulated digest history is preserved; only the *next* Promote starts using the new shape.

### Pattern PD — Deferred

**Shape.** You're not ready to commit to a promote shape during onboarding. Maybe your prod pipeline isn't fully wired yet, maybe you want to see mergecrew run on dev for a few days before deciding.

**PromotionStrategy config.**

```jsonc
{ "kind": "deferred" }
```

**What mergecrew does on promote.** Nothing — the Promote button is replaced by a chip on the project page reading "Promotion not configured · settings", linking back here. Daily runs still happen; changes still land on dev; the digest still accumulates approved/deferred/dropped state per changeset. You just can't ship.

Switch to a real strategy in **Settings → Promotion strategy** whenever you're ready. The accumulated digest is preserved.

## Cross-cutting

### Per-environment configuration

Each project gets at most one DeployTarget per `kind` (`dev`, `staging`, `prod`). Different kinds can use different adapters — using `github-actions observe` for `dev` and `aws-direct ecs` for `prod` in the same project is fine.

### Production is always human-gated

No adapter, no config combination, no env var bypasses the human approval for production. The promote button in the digest UI is the only path to call `triggerDeploy` on a `kind: "prod"` target. This is enforced in [`apps/runner/src/step.ts`](../../apps/runner/src/step.ts) and the orchestrator's [`maybeAdvanceWorkflow`](../../apps/orchestrator/src/orchestrator.ts) — there is no `auto_promote_to_prod` lifecycle gate.

### When deploys fail

The runbook's [Deploy adapter timeout](05-operator-runbook.md#deploy-timeout) section covers the most common failure (Mergecrew gave up polling while the deploy was still running) and the recovery steps.

### Adapter selection at a glance

| Adapter | Use it when | mergecrew dispatches? | mergecrew observes status? | Needs provider token? |
|---|---|---|---|---|
| `external-ci` | Existing CI/CD already deploys on merge; you only need the URL recorded | No (no-op) | No (assumes success) | No |
| `github-actions` (`observe`) | A `.github/workflows/` workflow already auto-deploys on push/PR | No | Yes — watches the existing run | App install |
| `github-actions` (`dispatch`) | A workflow you call via `workflow_dispatch` (typical for prod) | Yes (`workflow_dispatch`) | Yes | App install |
| `vercel` | Vercel imports the repo and builds previews automatically | No | Yes — polls Vercel's REST API | `VERCEL_TOKEN` |
| `netlify` | Netlify imports the repo and builds previews automatically | No | Yes — polls Netlify's REST API | `NETLIFY_TOKEN` |
| `render` | Render service rebuilds on git push | Yes (Render deploy hook) | Yes — polls Render's REST API | `RENDER_TOKEN` |
| `fly` | Fly machines deploy via REST API | Yes | Yes | `FLY_API_TOKEN` |
| `railway` | Railway service redeploy via GraphQL API | Yes | Yes | `RAILWAY_TOKEN` |
| `aws-direct` | Direct SDK call (Lambda update / ECS service / S3 sync); no CI in the middle | Yes | Yes | AWS env credentials |

When in doubt, pick `external-ci` first to get the loop running, then upgrade to the richer adapter once you want mergecrew to observe deploy outcomes or dispatch builds itself.

### Adding a new adapter

The contract is in [`packages/adapters-deploy/src/types.ts`](../../packages/adapters-deploy/src/types.ts). Implement `DeployProvider`, register the id in the union, wire the dispatch branch in `apps/runner/src/step.ts`. Tests live alongside each adapter under `packages/adapters-deploy/test/`.
