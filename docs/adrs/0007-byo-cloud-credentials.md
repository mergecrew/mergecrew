# ADR-0007: AWS auth via STS role assumption; envelope-encrypt PATs

**Status:** Accepted — 2026-05-23.

## Context

Two BYO profiles require credentials in the user's external system:

- `fargate_byo` needs to run ECS tasks in the user's AWS account.
- `github_actions` (v1.1 follow-up) needs a PAT to call `workflow_dispatch` on a repo the user owns.

For AWS, the naive shape is "user pastes an access key + secret access key into the runner-profile form; deployment encrypts and stores them." This is the model that loses laptops worth of credentials when SaaS DBs get exfiltrated. Long-lived AWS access keys are the worst category of credential to custody on someone else's behalf.

For GitHub, the equivalent is a PAT — a long-lived bearer token with whatever scopes the user granted. Same problem, smaller blast radius.

Existing precedent in the codebase: `CryptoService` (used at `schema.prisma:116` for `slackWebhookCiphertext` and at `schema.prisma:463` for project secrets) does envelope encryption against a `KMS_MASTER_KEY`. We can lean on it for any secret we end up storing.

## Decision

**AWS: STS role assumption, never long-lived keys.**

- The user creates an IAM role in their AWS account whose trust policy allows the deployment's AWS account (or `OIDC` provider, if the deployment uses one) to assume the role, with an `ExternalId` condition.
- We generate the `ExternalId` per-org on first save of the `fargate_byo` profile (UUID v4) and store it as plain text in `runner_profile.awsExternalId`. It's not a secret on its own — it's a shared-secret check against the trust policy.
- We store the role ARN, region, cluster name, task definition ARN, subnet/SG IDs — all of which are not secrets.
- At dispatch time, the dispatcher worker calls `sts:AssumeRole` with the role ARN + external ID, gets temporary credentials (typically 1 hour), and runs the ECS task with them.
- **No AWS access key is ever requested from the user or stored on the deployment.**

**GitHub: envelope-encrypted PAT.**

- The PAT is the only credential GitHub offers for `workflow_dispatch` against another user's repo. There is no role-assumption equivalent.
- We store `runner_profile.githubTokenCiphertext` encrypted via the existing `CryptoService` against `KMS_MASTER_KEY`.
- The PAT is never returned in any API response after creation; the operator must rotate via the UI if it's lost.

## Consequences

- For AWS: leakage of the deployment's DB does not leak any AWS credential; the worst case is exposure of role ARNs (which are useless without the trust relationship). This is the strongest posture available.
- For GitHub: blast radius equals the PAT's scope. We can't do better without a GitHub App, which is an order-of-magnitude larger feature.
- The trust-policy onboarding for AWS is a copy-paste step in the UI (with the external ID pre-filled). This is one screen of friction per org but a one-time cost.
- We inherit the `KMS_MASTER_KEY` rotation story for any encrypted PAT.

## Alternatives considered

- **Store AWS access keys, encrypted.** Rejected: encryption-at-rest is necessary but not sufficient — a leaked decryption key (or a compromised process) yields long-lived credentials. Role assumption gives temporary creds even after a full compromise.
- **OIDC federation to the user's AWS account.** Considered. Strictly stronger than external-ID role assumption (no shared secret at all). Deferred because it requires an OIDC provider on the deployment side and adds Terraform-ish setup to the operator's onboarding. We can revisit when the deployment story stabilizes.
- **GitHub App instead of PAT.** Considered. Strictly better for GitHub credentials (short-lived installation tokens, fine-grained scopes). Deferred because it's an order-of-magnitude larger feature (app registration, manifest, installation flow, permission UX). PAT is the v1.1 shape; GitHub App is the eventual destination.

## Realized in

- #761 — schema fields `aws_role_arn`, `aws_external_id`, `aws_region`, `fargate_*`, `github_token_ciphertext`.
- #767 / #769 — per-org `awsExternalId` generated on first `fargate_byo` save (never rotated); trust-policy snippet rendered in the UI with the value pre-filled.
- Follow-up #786 wires the runtime `sts:AssumeRole` + ECS dispatcher.
- Follow-up #772 tracks GitHub Actions PAT encryption when that profile ships.
