# Multi-tenancy

Mergecrew is multi-tenant from day one. This doc defines the isolation model, the boundaries each layer enforces, and the failure modes we explicitly defend against.

## Isolation model: shared infrastructure, per-tenant data

V1 uses **shared compute, shared database, per-tenant rows**. Justification:

- Mergecrew is positioned for solo founders and small teams. The economics of dedicated infra per tenant don't make sense at this stage.
- The strict isolation requirements (SOC 2, customer-managed keys, dedicated VPC) belong to enterprise customers, who are explicitly a V3 persona.
- Shared infra with rigorous tenancy enforcement is sufficient for the V1 personas if done correctly. "Done correctly" is the rest of this doc.

V3+ may add a dedicated-tenant tier (separate database, separate runner pool) for enterprise.

## Tenancy column

Every multi-tenant table has a non-null `organization_id` column. This includes:

- All domain tables (Project, Lifecycle, Workflow, Agent, Skill, Run, Changeset, …).
- All log tables (TimelineEvent, AuditLogEntry, LlmInvocation).
- All operational tables (ApprovalRequest, IntentInboxItem, Memory).

Tables that are inherently global (Users, OAuth state, public skill catalog metadata) carry no `organization_id`. The User table is global because a single human can belong to multiple organizations.

## Enforcement: layer by layer

### Layer 1 — Postgres Row-Level Security (RLS)

The hard floor.

- All tenant tables have RLS enabled.
- Each connection sets `app.org_id` via `SET LOCAL` at request start.
- RLS policy: `USING (organization_id = current_setting('app.org_id')::uuid)`.
- The application role used by NestJS has `BYPASSRLS = false`.
- A separate migration role has `BYPASSRLS = true` and is *only* used for migrations and explicitly-cross-tenant background jobs (e.g., the cost rollup).

Even if the API forgets to filter, RLS makes cross-tenant reads return empty and cross-tenant writes fail.

### Layer 2 — NestJS request context

- The session/JWT carries `organization_id` (current org) and `user_id`.
- A NestJS middleware resolves the org for the request, verifies the user has a Membership, and stores both in `AsyncLocalStorage`.
- A `TenantInterceptor` runs before each handler:
  - Sets `app.org_id` on the active database connection.
  - Asserts the org in the URL path (`/orgs/:org_slug/...`) matches the resolved org.
  - Rejects with 404 (not 403, to avoid revealing existence) on mismatch.
- A `@RequireRole('admin' | 'operator' | …)` decorator checks the membership role.

### Layer 3 — Repository helpers

- All Prisma queries use a thin repository layer that auto-injects `organization_id` into `where`. Direct Prisma access is forbidden by lint rule.
- Cross-tenant utilities (the cost rollup, telemetry export) use a separate `SystemRepository` that requires an explicit "I know what I'm doing" call.

### Layer 4 — Outbound calls

- LLM provider calls log `organization_id` and use the org's BYOK keys, not a global pool.
- Webhooks dispatched to user-supplied URLs are signed with a per-org HMAC.
- Cross-tenant fanout (e.g., the daily metrics email) is built from a single SystemRepository query that loops orgs explicitly.

### Layer 5 — Runner workspace isolation

- Each `DailyRun` executes in a per-run working directory under `/var/mergecrew/work/{run_id}/`.
- The directory is created (and the connected repo cloned into it) by the first agent step in the run; subsequent steps reuse the same working tree so the coder sees the planner's branch, the reviewer sees the coder's diff, etc. Cleanup is run-terminal: the orchestrator (on `done`) and the API (on `cancelled`) enqueue a `runner.workspace-cleanup` job that rms the directory.
- Skills that touch the filesystem are restricted (chrooted-by-convention) to the working directory; absolute paths outside are rejected at the skill level.
- Network egress from runners is allowlisted: GitHub, configured deploy adapters, configured LLM providers, observability sinks. Outbound to arbitrary URLs requires the user-defined `web.fetch_url` skill which logs the URL.

## Identity boundaries

- A `User` is a person. They can belong to multiple orgs.
- The "current org" for a session is part of the URL path (`/orgs/:slug`). Switching orgs is a navigation, not a session toggle. This is an explicit design choice (see `docs/01-design/02-information-architecture.md`).
- Mergecrew has no concept of a "super-admin" user that can read tenant data. Customer support access is gated by the per-org "Support access" feature: an org owner toggles support access on, which creates a time-bounded, audited Membership for the support team.

## Audit log

- Every security-relevant action writes an `AuditLogEntry`: auth (login, MFA, token revoke), org membership changes, role changes, secret edits, project deletions, policy changes, integration installs, BYOK key rotations.
- Audit logs are append-only.
- Audit logs are retained per the org's compliance setting (default 1 year, max 7 years).
- The audit log is exposed in Settings → Audit log.

## Cross-tenant leakage scenarios we test for

The test plan must include each of these as a "must fail" case:

1. **API parameter tampering.** User in org A passes a project_id that belongs to org B. Expect 404.
2. **JWT swap.** User crafts a JWT with org B's id. Expect 401 (the session is org-bound) and the swap rejected because membership lookup returns nothing.
3. **Webhook collision.** Org A's GitHub webhook secret leaks; an attacker tries to deliver events for org B's repo. Expect rejection (signature does not match the org's secret, and the installation_id doesn't match the project's connected repo).
4. **Direct DB query without RLS context.** A regression where a developer forgets `SET LOCAL app.org_id`. RLS denies reads/writes; tests that exercise the RLS path catch it.
5. **Skill side-effect targeting wrong org.** A skill receives a hand-crafted argument pointing at org B's resource. Skill executors validate that the resource belongs to the calling agent's project.
6. **Cost ledger pollution.** An LLM call logged with the wrong `organization_id`. The runner derives `organization_id` from the run's project, never from runtime input.
7. **Memory store mixing.** Vector memory from project A returned to project B. The embedding query carries `(organization_id, project_id)` as a hard filter.

## Quotas and noisy-neighbor controls

- Per-org concurrency cap on in-flight runs (default 5; configurable up).
- Per-org concurrency cap on parallel agent steps (default 20).
- Per-org daily token spend ceiling (configurable; alert at 80%, hard stop at 100%; user can raise).
- Runner queue prioritization is fair-share by org, not FIFO globally.
- Slow agents in one tenant cannot starve others: each org gets a queue lane with a guaranteed slice of runner capacity.

## What we deliberately do *not* do in V1

- Per-tenant database. (Considered for enterprise V3.)
- Per-tenant runner pool. (Same.)
- Customer-managed encryption keys (CMEK). (Same.)
- VPC peering. (Same.)
