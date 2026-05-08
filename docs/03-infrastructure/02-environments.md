# Environments

This doc covers two distinct concerns:

1. **Mergecrew's own environments** — where the Mergecrew platform itself runs.
2. **Tenant-facing environments** — `dev` and `prod` deploy targets that Mergecrew orchestrates *for* tenants. Mergecrew does not host these; the tenant's pipelines do (or Vercel for greenfield projects).

## Mergecrew's own environments

| Env | Account | Region | Notes |
|---|---|---|---|
| `dev` | `mergecrew-dev` | `us-east-1` | Engineering scratch space. Tear-downable. |
| `staging` | `mergecrew-staging` | `us-east-1` | Mirrors prod sizing at 25%. Holds a synthetic dogfood org. |
| `prod` | `mergecrew-prod` | `us-east-1` (primary), `us-west-2` (warm) | Live tenant data. |

### Promotion path (Mergecrew engineering)

1. PR → `dev` deployment auto-applies on merge to `dev` branch (or on PR for previews).
2. Cut a release candidate → deploys to `staging` automatically.
3. After staging soak (>24h or operator approval), Mergecrew engineering promotes to `prod`.

This is the same shape Mergecrew offers tenants. Once Mergecrew dogfoods itself, the agents propose changesets and the human gate is the staging→prod step.

### Account separation

- IAM trust between accounts uses cross-account roles, not long-lived keys.
- Production data is never replicated into dev or staging.
- A "dogfood" tenant exists in staging and (anonymized) in prod.

## Tenant-facing environments

A `Project` declares one or more `DeployTarget`s. The standard configuration has two:

- `dev` — receives every changeset's branch deploy.
- `prod` — receives only promoted changesets.

### `dev` deploy target

Possible adapters:

- **GitHub Actions.** Mergecrew calls `workflow_dispatch` with the changeset branch. The workflow does whatever the user already has it doing (build → push → AWS deploy → smoke). Mergecrew reads the `dev_url` from the workflow output (or a configured pattern).
- **Vercel.** Mergecrew does nothing — Vercel automatically creates a preview deployment when the branch is pushed via GitHub. Mergecrew polls Vercel's API to retrieve the preview URL and status.

Mergecrew does *not* require:
- Tenant infra running in Mergecrew's AWS.
- Tenant code being executed inside Mergecrew's runners (we run *agents* on tenant code, not the tenant's own application).

### `prod` deploy target

- The same adapter, with different config (e.g., `deploy-prod.yml` instead of `deploy-dev.yml`).
- Triggered only by a `Decision { kind: 'promote' }` from a user with the right role.
- The orchestrator merges PRs to the project's `default_branch` and triggers prod-deploy with the merge SHA.

### Optional `staging` deploy target

For tenants that want a staging step:

- Promotion from the digest can target `staging` first.
- A second promote (from the staging-resident changeset list) targets `prod`.
- The shape of "decision → deploy" is the same; only the configured target changes.

## Greenfield project defaults

When a tenant scaffolds a new project inside Mergecrew ("New project" wizard, no existing repo):

- A new GitHub repo is created (under the user's chosen org).
- A scaffolded NestJS+Next.js+Prisma monorepo is committed.
- A new Vercel project is created and linked to the GitHub repo.
- A managed Postgres (Neon) is provisioned.
- The Project's `dev` and `prod` deploy targets are set to Vercel's preview and production environments respectively.
- A starter `mergecrew.yaml` is committed at the repo root.

The user can opt out of any of these (e.g., "use my existing AWS pipeline instead of Vercel"); the wizard makes the opinionated path the default.

## Environment configuration management

Mergecrew does not manage tenant environment variables. Reasons:

- Tenants already have a system (GitHub Actions secrets, Vercel env vars, AWS Parameter Store).
- Mergecrew accessing tenant runtime secrets vastly increases blast radius.
- The agent runtime never needs tenant runtime secrets — only build-time and deploy-time, which the tenant's pipeline already has.

Mergecrew manages:
- Mergecrew's own platform secrets (KMS-backed).
- Per-org BYOK keys for LLM providers.
- Per-project Mergecrew integration tokens (Linear API key, Slack webhook, etc.).

## Smoke tests at onboarding

When a Project is connected:

1. Trigger a no-op deploy via the configured `dev` adapter (e.g., a commit to a `mergecrew-smoke-test` branch that only updates a `MERGECREW_SMOKETEST.md` file).
2. Wait for it to complete.
3. Verify URL resolution returns a reachable URL.
4. Tear down the smoke-test branch and PR.

If the smoke test fails, the project is marked "deploy adapter unverified" and runs are blocked until the user fixes config or rejects the smoke test (assumes responsibility).

## Cross-region considerations

V1 is single-region (`us-east-1` primary). Prod has a warm `us-west-2` standby:

- Aurora Global Database with a secondary cluster.
- S3 cross-region replication for `mergecrew-prod-artifacts`.
- DNS failover via Route 53 health checks.

DR target: RPO 5 minutes, RTO 60 minutes. Verified quarterly (V1.x).

## Environment-specific feature flags

Some features ship dark first. The flag system:

- Per-tenant flags evaluated server-side.
- Stored in Postgres + cached in Redis.
- Default values per environment.
- Visible in the audit log when changed.
- Used sparingly; the goal is "small flags, short lifetimes."
