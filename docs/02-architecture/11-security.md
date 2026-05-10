# Security

This document defines the security model for the Mergecrew project: what the OSS codebase protects out of the box, what is intended for a hosted tier or future work, and what is explicitly not promised. Items flagged "hosted-tier" or "Planned" are not enforced by the code today; operators running Mergecrew themselves should treat them as a checklist for their own deployment, not as guarantees from the project.

Out of scope for the OSS surface — these belong to a hosted tier or to operator-supplied infrastructure:

- MFA (TOTP).
- Egress allowlist via per-runner network policy.
- Container read-only root filesystem.
- Central log filter scrubbing by pattern + registered key prefix.
- Signed JWT for service-to-service calls.

## Threat model summary

Attackers we care about, in priority order:

1. **Confused-deputy across tenants.** A logged-in user of org A unintentionally or maliciously reaches data of org B. This is the highest-impact, highest-likelihood failure for a multi-tenant app.
2. **Stolen BYOK keys.** Anthropic / OpenAI / Bedrock credentials extracted from the database, logs, error messages, or memory dumps.
3. **Compromised GitHub App installation.** An attacker uses a leaked installation token to manipulate user code.
4. **Supply chain in agent-generated code.** An agent installs a malicious npm package; the package executes in a runner; secrets exfiltrate.
5. **Skill abuse.** A misconfigured or malicious skill exfiltrates files outside the workspace, or makes outbound calls to arbitrary URLs.
6. **Prompt injection from external content.** Issue body / customer feedback / documentation contains content that overrides the agent's instructions.
7. **Standard web app risks.** Auth, session, CSRF, XSS, SQLi, IDOR.

Out of scope for the project's explicit defenses:

- Determined nation-state actors.
- Post-quantum cryptographic threats.
- Side-channel attacks on the underlying cloud.

## Tenancy enforcement

Covered fully in `docs/02-architecture/03-multi-tenancy.md`. Five layers (RLS, NestJS context, repository helpers, outbound calls, runner workspace). The combination is what defends; no single layer is trusted alone.

## Authentication

- Sessions: NextAuth, JWT-shaped session cookies, 14-day rolling, signed with a rotating key.
- OAuth providers: GitHub today; Google Planned.
- Email + password: bcrypt-hashed; email verification (Planned).
- Login throttling: per-IP and per-email exponential backoff (Planned).
- Account recovery: email-based one-time link; rate-limited; logged in audit log (Planned).
- MFA (TOTP): hosted-tier / Planned — not enforced by the OSS codebase.

## Authorization

- Role-based per org (`owner`, `admin`, `operator`, `viewer`).
- Scoped permissions:
  - `owner`: anything, plus org deletion and billing.
  - `admin`: project + member management, integrations, secrets.
  - `operator`: run management, promote/rollback decisions, intent inbox, approvals.
  - `viewer`: read-only.
- Production-promote requires ≥ `operator`.
- Sensitive area approvals require ≥ `operator`.
- A `@RequireRole(role)` decorator on controllers is the only allowed gate; controllers without the decorator are caught by a startup check.

## Secret handling (BYOK keys, project secrets)

- Storage: envelope encryption. The OSS deployment uses a `KMS_MASTER_KEY` (32-byte base64 key in `.env`) as the master key encrypting a per-row data key; the data key encrypts the secret. Operators running in production should swap that for a managed KMS.
- Retrieval: only by short-lived service requests with explicit `purpose` (e.g., `purpose=llm_call:anthropic`).
- Decryption point: only on the runner that needs the secret, only for the duration of one outbound call.
- Rotation: the API exposes a "rotate" action that decrypts the current value, accepts the new value, atomically swaps, audit-logs the rotation. No "show me the key" endpoint.
- Logging: hosted-tier / Planned — a central log filter scrubbing by pattern (e.g., `sk-...`, `xoxb-...`) and by registered key prefix is not part of the OSS codebase. Operators should configure their log pipeline to redact provider-specific key prefixes.

## Code execution sandboxing

The runner executes user-derived workloads (agent-driven file edits, test commands). Out of the box the OSS code provides per-changeset workspace isolation, per-step wall-clock and abort-signal handling, and `--ignore-scripts` defaults. Stronger containment is hosted-tier or operator-supplied:

- Per-step wall-clock limit (default 20 minutes) — implemented.
- Workspace scoped to `/var/mergecrew/work/{run_id}/{cs_id}` and torn down at step end — implemented.
- `npm install` runs with `--ignore-scripts` by default; the agent must explicitly request scripts to run — implemented.

Hosted-tier / operator-supplied (not enforced by OSS code):

- Linux container with read-only root filesystem and writable `/var/mergecrew/work/...` mount.
- No host network mount, no Docker socket, no privileged mode.
- Egress allowlist via per-runner network policy: GitHub API, configured deploy adapter endpoints, configured LLM endpoints, observability sinks.
- Per-step CPU and memory limits (cgroups).

## Skill abuse defenses

- Every skill declares its `sideEffectClass` and `capabilities`. The runtime asserts at execution time.
- Skills cannot resolve paths outside the per-changeset working directory; absolute paths and `..` traversal are rejected before the skill runs.
- Skills cannot use raw `child_process` or shell. Skills that run external commands (`build.run_unit_tests`, etc.) use a constrained executor with allowlisted commands.
- Custom skills (defined in `mergecrew.yaml`) declare an OpenAPI/JSON-schema spec, an auth ref, and an HTTPS endpoint. The runtime won't execute a custom skill that targets an internal IP without explicit org-level opt-in.

### Egress allowlist scope (#188)

The per-project `egressAllowlist` (configured on the Project row) is enforced by `packages/skills/src/egress-policy.ts` against the **HTTP-bound** skills:

- `web.fetch_url`, `web.parse_url`, `web.fetch_image`, `web.fetch_html` (`packages/skills/src/stock/web.ts`).
- Custom skills declared in `mergecrew.yaml` with an HTTPS endpoint (`packages/skills/src/http-skill.ts`).

It is **not** enforced against:

- **Shell-based stock skills** that wrap `execa` — `build.run_install`, `build.run_unit_tests`, `build.run_integration_tests`, `build.run_lint`, `build.run_typecheck`, `repo.git.*`. A build script can `curl` / `wget` / `npm install` from anywhere reachable from the runner host. The same shell can pipe data out via standard tooling.
- Anything the underlying tools reach without going through Node's network APIs (DNS, raw sockets, etc.).

The implication: the allowlist is a **soft control** today — it stops an agent from calling `web.fetch_url("evil.com")`, but doesn't stop a build script the agent commits and runs from doing the same. Operators who need a hard control should either:

- Reduce the surface — gate `build.*` and `repo.git.*` skills behind explicit project policy and audit each command's network access.
- Apply network policy at a layer below the runner (k8s NetworkPolicy, AWS VPC egress controls, host-level iptables / nftables) — the OSS doesn't run shell commands inside a network namespace today.

This is a known gap and is tracked alongside the broader runner-isolation work (#187, #188).

## Prompt injection mitigations

- Inputs from external content (issues, customer feedback, docs) are wrapped in `<external_content>` tags in the system prompt and explicitly described as untrusted.
- The system prompt instructs agents to ignore commands appearing inside external content.
- The policy engine forces a human gate when an agent attempts a high-impact tool call (e.g., `repo.git.commit` in a sensitive area, `web.fetch_url` to a new domain) right after consuming an external content blob.
- Tool calls are inspected for "obviously injected" patterns (e.g., a write to `.github/workflows/*` triggered immediately after reading a customer email).
- This is a layered defense, not a guarantee. The hard guarantee is the production gate.

## GitHub App security

- Webhook signatures verified (HMAC SHA-256 over the body, constant-time compare in `packages/adapters-vcs/src/github.ts`).
- Installation tokens fetched on demand via `@octokit/auth-app`, used briefly, never stored in the database.
- App private key supplied via env / KMS; a short-lived JWT is generated per request.
- Service-to-service signed JWT for internal calls is hosted-tier / Planned.
- Surfacing suspicious patterns (unexpected uninstall, unexpected repo removal) to org admins is Planned.

## Data retention & purge

- Tenant data soft-delete: 30 days, then hard-delete (per `Project` and `Organization`).
- Transcripts: 90 days default; configurable down to 30 days or up to 1 year.
- Raw LLM request/response blobs: 30 days default.
- Audit log: retained per the org's compliance setting (default 1 year, max 7 years).
- A documented purge job runs daily; misses surface as alerts.

## Backups

- Daily automated Postgres backups, encrypted at rest.
- Monthly off-region snapshot.
- Object storage cross-region replication.
- DR exercise quarterly (V1.x).

## Compliance posture

Compliance is a hosted-tier concern. The OSS project documents controls so an operator-led readiness assessment is short. SOC 2, GDPR DPA, HIPAA, FedRAMP, and similar are not promised by the project.

## Logging & monitoring

- All auth events logged.
- All authorization decisions for `require-approval` and `irreversible` actions logged.
- All secret reads logged (purpose, requestor, target).
- All outbound LLM calls logged with redacted prompts (full body in object storage; logs reference the blob URL).
- Anomalies surfaced to a channel watched by the security team:
  - Burst of "decryption failed" events (key compromise indicator).
  - Multi-region access for the same session.
  - Sudden spike in `web.fetch_url` calls per project.
  - Repeated 401s from the same IP.

## Vulnerability disclosure

- Public security policy lives in the repo's `SECURITY.md`. Reports go to the project's security contact published there.
- A bug bounty is hosted-tier only.

## What the OSS project does not promise

- Customer-managed encryption keys (CMEK).
- Dedicated VPC / dedicated infrastructure.
- SAML/SCIM SSO.
- Audit log streaming to a customer SIEM.
- HIPAA / FedRAMP / IL-anything.
