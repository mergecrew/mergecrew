# Security

This document defines the security model: what we protect, how we protect it, and what we explicitly do not promise in V1.

## Threat model summary

Attackers we care about, in priority order:

1. **Confused-deputy across tenants.** A logged-in user of org A unintentionally or maliciously reaches data of org B. This is the highest-impact, highest-likelihood failure for a multi-tenant app.
2. **Stolen BYOK keys.** Anthropic / OpenAI / Bedrock credentials extracted from the database, logs, error messages, or memory dumps.
3. **Compromised GitHub App installation.** An attacker uses a leaked installation token to manipulate user code.
4. **Supply chain in agent-generated code.** An agent installs a malicious npm package; the package executes in a runner; secrets exfiltrate.
5. **Skill abuse.** A misconfigured or malicious skill exfiltrates files outside the workspace, or makes outbound calls to arbitrary URLs.
6. **Prompt injection from external content.** Issue body / customer feedback / documentation contains content that overrides the agent's instructions.
7. **Standard web app risks.** Auth, session, CSRF, XSS, SQLi, IDOR.

Out of scope for V1 explicit defenses:

- Determined nation-state actors.
- Post-quantum cryptographic threats.
- Side-channel attacks on the underlying cloud.

## Tenancy enforcement

Covered fully in `docs/02-architecture/03-multi-tenancy.md`. Five layers (RLS, NestJS context, repository helpers, outbound calls, runner workspace). The combination is what defends; no single layer is trusted alone.

## Authentication

- Sessions: NextAuth, JWT-shaped session cookies, 14-day rolling, signed with a rotating key.
- OAuth providers: Google, GitHub.
- Email + password: bcrypt-hashed; email verification mandatory before first login.
- MFA: TOTP, optional in V1, mandatory in V1.x for `owner`/`admin` roles.
- Login throttling: per-IP and per-email exponential backoff.
- Account recovery: email-based one-time link; rate-limited; logged in audit log.

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

- Storage: envelope encryption. KMS-managed master key encrypts a per-row data key; the data key encrypts the secret.
- Retrieval: only by short-lived service requests with explicit `purpose` (e.g., `purpose=llm_call:anthropic`).
- Decryption point: only on the runner that needs the secret, only for the duration of one outbound call.
- Logging: secrets are redacted in all logs, error messages, and stack traces. A central log filter scrubs by pattern (e.g., `sk-...`, `xoxb-...`) and by registered key prefix.
- Rotation: the API exposes a "rotate" action that decrypts the current value, accepts the new value, atomically swaps, audit-logs the rotation. No "show me the key" endpoint.
- Backup: KMS keys are not backed up to user-readable storage.

## Code execution sandboxing

The runner executes user-derived workloads (agent-driven file edits, test commands). Containment:

- Each runner process is a Linux container with read-only root filesystem and a writable `/var/mergecrew/work/{run_id}` mount.
- No host network mount, no Docker socket, no privileged mode.
- Egress allowlist via a per-runner network policy: GitHub API, configured deploy adapter endpoints, configured LLM endpoints, observability sinks. The `web.fetch_url` skill bypasses with logging and per-changeset rate limiting.
- Per-step CPU and memory limits (cgroups).
- Per-step wall-clock limit (default 20 minutes).
- No persistent filesystem across runs. Workspaces are scrubbed at step end.
- `npm install` runs with `--ignore-scripts` by default; the agent must explicitly request scripts to run, gated by the policy engine for production-bound builds.

## Skill abuse defenses

- Every skill declares its `sideEffectClass` and `capabilities`. The runtime asserts at execution time.
- Skills cannot resolve paths outside the per-changeset working directory; absolute paths and `..` traversal are rejected before the skill runs.
- Skills cannot use raw `child_process` or shell. Skills that run external commands (`build.run_unit_tests`, etc.) use a constrained executor with allowlisted commands.
- Custom skills (defined in `mergecrew.yaml`) declare an OpenAPI/JSON-schema spec, an auth ref, and an HTTPS endpoint. The runtime won't execute a custom skill that targets an internal IP without explicit org-level opt-in.

## Prompt injection mitigations

- Inputs from external content (issues, customer feedback, docs) are wrapped in `<external_content>` tags in the system prompt and explicitly described as untrusted.
- The system prompt instructs agents to ignore commands appearing inside external content.
- The policy engine forces a human gate when an agent attempts a high-impact tool call (e.g., `repo.git.commit` in a sensitive area, `web.fetch_url` to a new domain) right after consuming an external content blob.
- Tool calls are inspected for "obviously injected" patterns (e.g., a write to `.github/workflows/*` triggered immediately after reading a customer email).
- This is a layered defense, not a guarantee. The hard guarantee is the production gate.

## GitHub App security

- Webhook signatures verified.
- Installation tokens fetched on demand, used briefly, never stored in the database.
- App private key stored in KMS; a short-lived JWT is generated per request.
- Suspicious patterns (unexpected uninstall, unexpected repo removal) are surfaced to org admins.

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

- V1: SOC 2 Type 2 readiness as a goal, not a claim. We document controls so the readiness assessment is short.
- V1.x: SOC 2 Type 2 audit started.
- V2: GDPR Data Processing Agreement available; right-to-be-forgotten covered by the org-deletion path.
- V3: HIPAA / FedRAMP not promised; if a customer asks, dedicated infrastructure tier required.

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

- Public security policy: `/.well-known/security.txt` pointing at `security@mergecrew.<domain>`.
- Bug bounty: V2.

## What we don't promise in V1

- Customer-managed encryption keys (CMEK).
- Dedicated VPC.
- Self-hosted runners.
- SAML/SCIM SSO (V3).
- Audit log streaming to a customer SIEM (V2).
- HIPAA / FedRAMP / IL-anything.
