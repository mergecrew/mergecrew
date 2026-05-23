# ADR-0006: Trusted-org gating for the instance-builtin profile

**Status:** Accepted — 2026-05-23.

## Context

The whole point of ADR-0002 (per-org runner profile) is that new tenants on a hosted instance must not silently run on the operator's compute. But for a self-hosted single-org install, the owner _is_ the operator and should keep using their own machine — that's the whole point of self-hosting. We need a mechanism that says "this org is allowed to pick `instance_builtin`" without baking it into the data model in a way that drifts between environments.

Possible mechanisms:

1. **A `trusted: bool` column on `organizations`.** Persistent in the DB. Set by operator action.
2. **An env var listing trusted org slugs.** Reproducible across deploys; same value in staging and prod for the same setup.
3. **First-org-is-trusted heuristic.** No config; the org created during `pnpm seed:owner` is trusted.

Option 3 is friendly for first-install but has no answer for "I want to add my work org to my homelab instance and trust both" — you'd have to flip a flag in the DB. Option 1 puts the trust decision in DB state, which is fine until the operator restores from a backup and finds a different set of orgs trusted than they expected; it also makes "promote ACME to trusted on the next deploy" a manual SQL change. Option 2 keeps trust as a deploy-time decision, reproducible via config-as-code.

## Decision

A new env on the API: `MERGECREW_TRUSTED_ORG_SLUGS=<comma-separated>`. The owner slug from `MERGECREW_OWNER_ORG_SLUG` (existing convention in the self-host runbook) is implicitly included if set, so single-org self-hosters with the owner slug already configured don't need any new env.

When the env is unset and `MERGECREW_OWNER_ORG_SLUG` is unset, **no org** sees `instance-builtin` as an option. The deployment is "BYO-only" until the operator decides to trust someone.

Validation:

- `PATCH /api/v1/orgs/:slug/runner-profile` rejects `kind=instance_builtin` for any org not in the allowlist (server is authoritative).
- The web UI hides the option for non-trusted orgs but the server check is what actually enforces.

## Consequences

- Trust lives in deploy config, not DB state. Reproducible across staging/prod; no surprise after a DB restore.
- A first-time self-hoster following the quickstart already sets `MERGECREW_OWNER_ORG_SLUG` (the seed script needs it); their org is implicitly trusted with no extra step.
- Adding a second trusted org requires editing the env and redeploying — slightly heavier than a UI flip, but the friction is appropriate to the risk (granting an org access to operator-owned compute is a serious decision).
- The env is read at request time (not boot time) so a redeploy isn't strictly necessary if the operator changes it via a hot-reload mechanism — but we don't promise that.

## Alternatives considered

- **`trusted: bool` column.** Rejected for the drift-from-config reason above. Also forces a "who can flip the bit?" UX question (only instance owners? all org owners?) that env-based config sidesteps.
- **First-org-is-trusted heuristic.** Rejected: ambiguous on multi-org installs, and the implicit-trust behavior on org creation is exactly the failure mode we're trying to prevent.
- **No gating; let every org pick `instance_builtin`.** Rejected: this is the foot-gun the milestone exists to fix.
