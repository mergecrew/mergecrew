# ADR-0002: Per-org `runner_profile` replaces global `RUNNER_SANDBOX`

**Status:** Accepted — 2026-05-23.

## Context

Today the sandbox driver is selected once at supervisor startup via the `RUNNER_SANDBOX` env (`packages/sandbox-driver/src/factory.ts`, `apps/runner/src/main.ts`). One choice — `process | docker | k8s | fargate | e2b` — applies to every step from every org on the deployment. This works for single-tenant self-host installs but has two structural problems for a hosted multi-tenant deployment like `mergecrew.dev`:

1. **Trust.** A new org signing up gets the operator's container substrate by default. The operator is now running every tenant's code on their VM with no opt-in.
2. **Cost.** If the operator pays for the runner pool, they bear the compute cost for every tenant. There is no boundary at which "you bring your own compute" can be enforced.

We considered keeping the global env and layering a per-org "allowed?" flag on top, but that conflates "is this org trusted?" with "where does its compute happen?" — and once a second org wants Fargate-in-their-AWS while the operator runs Docker, a single global driver can't express it at all.

## Decision

We will store the runner choice **per organization** in a new `runner_profile` row (1:1 with `Organization`). The profile carries:

- `kind`: `none | instance_builtin | agent | fargate_byo | github_actions`.
- Per-kind config (AWS role ARN + external ID for `fargate_byo`, GitHub repo + workflow + encrypted PAT for `github_actions`).

`instance_builtin` orgs continue to use the deployment's `RUNNER_SANDBOX` configuration as today — the global env is now the config bundle for that specific profile, not for the whole deployment. `agent` orgs run a pull-based `runner-agent` container themselves. `fargate_byo` orgs supply an AWS role we assume into.

The orchestrator reads the profile at dispatch time and routes the step accordingly (see ADR-0005). The supervisor only consumes the `instance_builtin` queue.

## Consequences

- New first-class concept (`runner_profile`) in the data model, with RLS like every other tenant table.
- Existing single-org deployments are unaffected: the migration in #761 backfills every existing org to `instance_builtin`, and the supervisor's behavior with `RUNNER_SANDBOX` is unchanged for those orgs.
- The global env becomes scoped — it no longer describes "the runner" but "the instance-builtin runner." `docs/02-architecture/13-runner-isolation.md` will note this.
- Future runner kinds (k8s-byo, firecracker, etc.) are just new enum values, not new global envs.

## Alternatives considered

- **Per-project profile.** Rejected: agent enrollment is org-level (one token, one process). Per-project would require duplicating credentials for every project an org owns.
- **Single boolean column on `organizations`** ("can use the deployment's runner"). Rejected: no room for per-kind config (role ARN, encrypted PAT, etc.). We'd end up with the same `runner_profile` table eventually, with a worse migration story.
- **Keep the global env and rely on quotas to bound cost.** Rejected: solves cost but not trust, and the operator's compute is still the default attack surface.

## Realized in

- #761 — `runner_profiles` table + backfill.
- #762 — `GET /api/v1/orgs/:slug/runner-profile`.
- #763 — orchestrator reads `kind` at dispatch time.
- #767 — `PATCH` + dedicated settings page.
