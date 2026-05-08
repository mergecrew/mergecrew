# Disaster recovery & incident response

## Failure scenarios and responses

### S1 — A single ECS task crashes

- **Detection.** ECS health check fails; task replaced.
- **User impact.** None for `api` (load-balanced). For `runner-pool`, in-flight steps on the dead task time out and are re-dispatched.
- **Action.** Automatic. Page only if it's a crash loop (>3 in 10m).

### S2 — Postgres primary loses an AZ

- **Detection.** Aurora multi-AZ failover triggers within ~30s.
- **User impact.** Brief 502s during failover. SSE clients reconnect automatically.
- **Action.** Automatic. Verify replica lag normalizes.

### S3 — Redis outage

- **Detection.** ElastiCache replica promotes; if replica also down, hard outage.
- **User impact.** BullMQ dispatch stalls; runs marked `paused-rate-limit` by orchestrator's safety check (since outbound dispatch fails). Runs resume automatically when Redis returns.
- **Action.** Page on-call if Redis unreachable >2m. Failover within minutes.

### S4 — Anthropic / OpenAI / Bedrock provider outage

- **Detection.** Circuit breaker opens for the provider.
- **User impact.** Runs depending only on this provider pause. Runs with configured fallback fail over.
- **Action.** Automatic. Status page notes the upstream issue. No page unless fallback also fails.

### S5 — Region-wide AWS outage

- **Detection.** Route 53 health checks fail in `us-east-1`.
- **User impact.** Service unavailable until DNS shifts to `us-west-2`. Already-deployed changesets and digest results are accessible from cross-region replicated S3.
- **Action.** Manual cutover decision (the warm standby is not auto-promoted). RTO ~60m.

### S6 — Database corruption / dropped table

- **Detection.** Application errors, manual report.
- **Action.** Restore from PITR backup to a side cluster, identify divergence, copy in. Targeted recovery, not full restore.
- **Affected window.** Up to 5 min (RPO).

### S7 — Security incident: tenant access leak

- **Detection.** Audit log anomaly, customer report, SIEM alert.
- **Action plan.**
  1. Rotate platform-level secrets (KMS keys, JWT signing keys).
  2. Invalidate all sessions.
  3. Pause all runs platform-wide.
  4. Forensics on audit log + access logs.
  5. Per-tenant communication within 48h.
- **Post-mortem.** Public within 30 days for tenant-affecting incidents.

### S8 — Security incident: BYOK key exposure

- **Detection.** Alert on bulk decrypt, customer notice, provider's own alert.
- **Action plan.**
  1. Disable the affected provider config in Mergecrew.
  2. Notify the org owner with a one-tap "rotate all my LLM keys" action.
  3. Audit which calls used the key during the suspect window.
  4. Coordinate with the provider for any necessary revocation on their side.
- **User-side step.** The owner generates new keys with the provider, uploads them to Mergecrew.

### S9 — GitHub App compromise

- **Action plan.**
  1. Revoke the App's installation tokens (GitHub-side admin).
  2. Rotate the App private key in KMS.
  3. Pause runs for all affected installations.
  4. Communicate to org owners.
- **Recovery.** Re-key, then re-issue installation tokens; runs resume.

## Backup model

| Data | Backup | Retention | Verification |
|---|---|---|---|
| Postgres (Aurora) | Continuous PITR + daily snapshot | 30 days PITR, 1 yr snapshot weekly | Quarterly restore drill |
| S3 artifacts | Versioning + cross-region replication | 1 year | Quarterly random object check |
| KMS keys | AWS-managed multi-AZ | N/A | N/A |
| Vercel | Git history (source of truth) | per repo | N/A |
| Redis | Not backed up (ephemeral) | N/A | Reconstructed from Postgres on cold start |

## DR exercises

- **Quarterly.** Restore prod Postgres to a side cluster from PITR. Verify schema, row counts within tolerance, RLS policies intact. Tear down.
- **Semi-annually.** Region failover dry run: shift DNS in staging to the warm standby; run synthetic project; verify outcomes.
- **Annually.** Full incident tabletop covering S7 (tenant access leak).

## Data integrity invariants we monitor

- For every `Decision { kind: 'promote' }` row, there exists a corresponding `Deploy` row to the project's prod target.
- For every `Changeset` in `pr_open` state for >24h with no Decision, there is an open ApprovalRequest or it appears in the digest.
- For every `LlmInvocation`, there exists an `agent_step` with the same id.
- No `agent_step` carries `organization_id` ≠ its parent `daily_run.organization_id`.

These run as nightly Postgres queries; failures alert the team.

## Run safety properties

We design the orchestrator so that the following are *true by construction*:

- A daily run advances only via durable state transitions; no in-memory state controls progress.
- A step is dispatched at-least-once and made effectively at-most-once via idempotent skill execution.
- A pause never exceeds 30m without the user being able to see the reason.
- A cancel is observed within 30s by all active runners on that run.
- A promote-to-prod is preceded by exactly one `Decision { kind: 'promote' }` row written transactionally with the prod-deploy trigger.

## Operational runbooks (V1 set)

Each runbook lives in the engineering repo under `docs/runbooks/`:

- `runbook-orchestrator-stuck.md` — when no runs are advancing.
- `runbook-redis-down.md`.
- `runbook-aurora-failover.md`.
- `runbook-region-cutover.md`.
- `runbook-byok-rotation.md`.
- `runbook-purge-tenant.md` (in case of GDPR-style deletion request).
- `runbook-restore-from-pitr.md`.
- `runbook-paused-runs-stuck.md` — find runs paused >2h and unblock.

Each runbook is a numbered checklist with rollback steps if the action goes wrong.

## On-call

- One engineer on call per week.
- Pages route through PagerDuty.
- Acknowledge SLO: 5 minutes.
- All pages followed by a written incident note in `#incidents` channel; resolved incidents get a brief writeup; P0/P1 get formal post-mortems within 14 days.
- Customer comms for P0 within 1 hour; for P1 within 4 hours.
