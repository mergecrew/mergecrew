# ADR-0004: Enrollment token format and storage for runner-agent

**Status:** Accepted — 2026-05-23.

## Context

Each enrolled runner-agent needs a long-lived bearer credential that proves it belongs to a specific org. The existing `ApiKey` model in `packages/db/prisma/schema.prisma` shows the shape we already use for human-scoped credentials: `tokenHash`, `prefix`, one-shot reveal at creation, revoke-on-demand. Reusing that table would couple human credentials and machine credentials into one lifecycle — same audit shape, same UI surface, same revocation semantics. That mixing has gone badly in other codebases where machine creds need different rotation cadence, different scopes, and different UX (humans see a list of "API keys for the platform"; agents are infrastructure).

Token format also matters: the `mc_…` prefix on existing keys is generic. We want the agent token to be visually distinct so users don't paste an API key when they meant to paste an agent token.

## Decision

We introduce a new `RunnerAgent` model:

- `id`, `organizationId`, `name` (user-chosen, e.g. `homelab-1`).
- `tokenHash`: sha256 hex of the bearer token.
- `prefix`: first 14 chars of the token (`mca_<orgSlug>_<6 random>`), stored for UI display.
- `createdByUserId`, `createdAt`, `lastSeenAt`, `revokedAt`, `agentVersion`.
- RLS modeled on `audit_log_entries`.

Token shape: `mca_<orgSlug>_<26 base32 chars>`. The `mca` prefix ("mergecrew agent") is the visual distinguisher from `mc_` API keys; embedding the org slug helps with troubleshooting (operators can see which org a leaked token belongs to without DB access).

Lifecycle:

- Create: server generates a token, hashes it, returns the plaintext **exactly once** in the API response. The web UI shows a copy-on-click reveal that disappears on close. After that, the token is unrecoverable.
- Authenticate: every agent call hashes the bearer token, looks up the row, updates `lastSeenAt`. Rejects if `revokedAt IS NOT NULL`.
- Revoke: sets `revokedAt`. Subsequent calls fail 401.
- Rotate: revoke + create.

Rate-limit the `/poll` and `/hello` endpoints by `tokenHash` (not by IP). Bearer credentials get brute-forced through proxies otherwise.

## Consequences

- Machine creds have their own table, audit log entries, and UI section — no overlap with `ApiKey`.
- Plaintext tokens are never stored; if the DB leaks, the worst case is `lastSeenAt` exposure.
- One-shot reveal means a lost token requires re-enrollment, which is a known UX cost we accept.
- The visible org slug in the prefix is a minor information leak (anyone seeing `mca_acme_xxxxxx` knows ACME has agents) — acceptable in exchange for ops clarity.

## Alternatives considered

- **Reuse `ApiKey` table.** Rejected: different lifecycle (machine vs human), different revoke semantics in practice, different rate-limit shape. Mixing them creates a foot-gun around scope rules and audit interpretation.
- **mTLS / client certs.** Rejected: operationally heavier for an OSS user running `docker run`; revoke needs a CRL we don't have; trust roots add infrastructure surface.
- **JWT signed by the API with embedded org claim.** Rejected: stateless tokens make revoke racy (you need a denylist anyway), and the token-as-DB-row approach lets us cheaply add fields like `agentVersion` or `lastSeenAt`.

## Realized in

- #761 — `runner_agents` table.
- #765 — issue/list/revoke endpoints + `/hello` resolver.
- #766 — token reused on `/poll`, `/heartbeat`, `/steps/:id/events`, `/steps/:id/outcome`.
