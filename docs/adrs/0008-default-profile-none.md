# ADR-0008: Default runner profile is `none`; runs blocked at scheduling

**Status:** Accepted — 2026-05-23.

## Context

When a brand-new org signs up on a hosted instance, what should happen the first time it tries to run something? Options:

1. **Default to `instance_builtin`.** Silently runs on the operator's compute. This is exactly what we're trying to prevent.
2. **Default to an unconfigured `none` state.** The org cannot run until it configures a profile. The first `runNow` returns a clear error with a "Configure a runner" CTA.
3. **Default to an opportunistic local process driver.** No isolation, no resources, but the org can technically run something. Setting this default normalizes the unsafe posture flagged at `factory.ts:147`.

Option 1 is the foot-gun the milestone exists to fix. Option 3 starts every new org in the worst possible security posture. Option 2 is friction, but the friction matches the safety story — _you must opt into a runner before you can run_.

There's also the existing pause precedent (`runsPausedAt` checked at `apps/api/src/modules/run/run.service.ts:73`). It already implements the "block at scheduling with a clear UI message" UX for a different reason. We can reuse the same pattern, which means the failure mode is familiar and the UI surfaces it consistently.

## Decision

`RunnerProfile.kind` defaults to `none`. When an org with `kind=none` tries to schedule a run:

- `apps/api/src/modules/run/run.service.ts`: the `runNow` validator rejects with a 422 and message `Configure a runner profile before starting runs`. This mirrors the `runsPausedAt` rejection shape.
- `apps/orchestrator/src/orchestrator.ts`: any step that races past the API check (cron-triggered, etc.) is marked `failed` at dispatch with reason `runner_not_configured` and an `AGENT_STEP_FAILED` event surfaces in the run timeline. The orchestrator never enqueues a step for a `none` org.

The web UI surfaces a banner in the run timeline and on the org's home page when `kind=none`, linking to `settings/runner` with a "Configure a runner" CTA.

For an existing single-org deployment: the migration in #761 backfills every pre-existing org to `kind=instance_builtin`, so no existing behavior changes. The `none` default applies only to orgs created after the migration.

## Consequences

- A new org cannot footgun the operator's compute. The "trust" check is enforced both at profile-PATCH time (ADR-0006) and at scheduling time (here).
- New-org onboarding has an explicit "configure a runner" step. Documented in the self-host runbook + the quickstart.
- The pause precedent is reused, so the failure mode is consistent with an existing pattern operators already understand.
- Cron-triggered runs against a `none`-profile org surface a clear failure in the timeline instead of silently dropping — matters for catching misconfiguration.

## Alternatives considered

- **Default to `instance_builtin`.** Rejected — see context.
- **Default to an unsandboxed process driver.** Rejected — see context.
- **Default to `none` but enqueue jobs and hold them.** Considered. Rejected because holding jobs in a queue with no consumer creates silent backlogs that surprise operators on profile-change. Failing fast at scheduling makes the misconfiguration loud.
- **Default to `agent` and tell the user "now go enroll an agent."** Considered. Rejected because `agent` profile with zero enrolled agents is functionally equivalent to `none`, and surfacing two distinct states ("you need to pick a profile" vs "you picked agent but haven't enrolled one") makes the error UX worse, not better.
