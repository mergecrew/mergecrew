# Decision: E2B (self-hosted) over rolling our own Firecracker stack

**Status:** reversed (#773, 2026-05-27) — original status: accepted (#579, 2026-05-19)
**Drivers:** mergecrew maintainers
**Replaces:** —

> **Reversed by #773.** After V2.af (#759) shipped the BYO `runner-agent`,
> the dedicated `e2b` driver became redundant: an operator who wants
> Firecracker-microVM isolation can run `mergecrew/runner-agent` inside
> an E2B sandbox themselves and select `runner_profile.kind = 'agent'`.
> The `e2b-driver.ts` / `e2b-api-client.ts` files and `RUNNER_SANDBOX=e2b`
> support have been removed; the `e2b` SDK is no longer a dependency.
> Migration path: see [BYO runner agent](../03-infrastructure/34-runner-agent.md).
>
> The body below is preserved as the historical record of the original
> Phase 5 decision.

## Context

Phase 5 of the runner isolation EPIC (#555) calls for snapshot-based
microVM execution to push sandbox cold-start under 5 seconds. The RFC
(`docs/02-architecture/13-runner-isolation.md` §5.1, §5.5, §6) sketched
two options:

1. **Roll our own Firecracker host service.** Direct microVM control
   via the Firecracker API: jailer, vsock, drive snapshots, an in-VM
   agent that exec()s commands and streams I/O.
2. **Integrate with [E2B](https://github.com/e2b-dev/infra).** Apache-2.0
   licensed microVM platform purpose-built for AI-agent sandboxes;
   manages the Firecracker fleet, snapshot lifecycle, templating, and a
   stable client SDK on our behalf.

## Decision

**Adopt E2B self-hosted as the Phase 5 driver.** Fall back to a
direct-Firecracker implementation only if a future requirement isn't
addressable inside E2B.

## Rationale

- **No paid services.** E2B's commercial offering is a hosted cloud,
  but the same code is Apache-2.0 (`e2b-dev/infra`). Self-hosting
  satisfies `feedback_no_paid_services.md` while still benefiting
  from a maintained microVM platform.
- **Battle-tested over bespoke.** Per `feedback_battle_tested_over_bespoke.md`,
  default to mature widely-adopted libraries. E2B has ~5k GitHub stars,
  is used in production at multiple AI shops, and has a stable JS/Python
  SDK. Building our own Firecracker control plane would be 6–12 months
  of work that doesn't differentiate mergecrew.
- **Same security envelope.** E2B sandboxes are KVM-backed Firecracker
  microVMs — the isolation property is the same regardless of who manages
  the host service. We retain the per-project egress allowlist (#10) at
  the L7 layer above the VM.
- **Stable seam.** Our `SandboxDriver` interface fits E2B's lifecycle
  (`Sandbox.create()` → `commands.run` → `files.read/write` → `kill`)
  without contortion. If we ever need to swap to a direct-Firecracker
  driver, only the `E2BApiClient` adapter changes.
- **OSS contributor ramp-up.** A new contributor adding a stack-specific
  E2B template ships in hours. The same contribution on a bespoke
  Firecracker stack would require understanding our jailer config,
  vsock agent protocol, and snapshot lifecycle — barrier far too high
  for an OSS project aiming for adoption (`project_public_oss_goal.md`).

## Consequences

- The E2B SDK is added as an `optionalDependencies` so non-microVM
  operators (process / docker / k8s / fargate) don't pay the install
  cost.
- Operators who want microVM isolation deploy the open-source E2B
  control plane on Nomad/AWS, point `RUNNER_E2B_DOMAIN` at it, and
  flip `RUNNER_SANDBOX=e2b`. E2B's docs cover the Nomad cluster setup.
- mergecrew never embeds an E2B API key for a hosted account in its
  default config. The driver requires `RUNNER_E2B_API_KEY` only when
  the operator points it at a hosted E2B; self-hosted may run with the
  flag absent.
- The 5s cold-start target is achievable via E2B's snapshot-restore
  path; operators on the slow path (first-time template build) see
  10–30s on the very first run while the template caches.

## Comparable: when to revisit

Reconsider the direct-Firecracker option only if:

- E2B's release cadence stops keeping up with Firecracker upstream.
- A regulatory requirement (e.g. FedRAMP) requires a clean-room control
  plane.
- A specific workload pattern (e.g. very long-lived sandboxes >24h)
  hits a hard limit in E2B's design.

None of these apply today.

## Refs

- E2B OSS infra: https://github.com/e2b-dev/infra
- E2B JS SDK: https://github.com/e2b-dev/e2b/tree/main/packages/js-sdk
- RFC: `docs/02-architecture/13-runner-isolation.md`
- Memory: `feedback_no_paid_services.md`, `feedback_battle_tested_over_bespoke.md`
- Driver: `packages/sandbox-driver/src/e2b-driver.ts`
