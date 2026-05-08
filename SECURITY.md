# Security Policy

## Reporting a vulnerability

If you discover a security issue in Mergecrew, please report it privately. **Do not** open a public issue.

Preferred channel:
- [GitHub private vulnerability reporting](https://github.com/mergecrew/mergecrew/security/advisories/new)

Alternate channel:
- Email <security@mergecrew.dev> (once provisioned), or DM a maintainer privately on GitHub.

## Response expectations

We aim to:
- Acknowledge reports within 72 hours.
- Provide an initial assessment within 7 days.
- Coordinate a fix and disclosure timeline with the reporter.

Mergecrew is in alpha and does not yet operate a paid security program. We will credit reporters in release notes unless they request otherwise.

## Scope

In scope:
- The Mergecrew codebase in this repository.
- Default configurations shipped in `.env.example`, `docker-compose.yml`, `infra/sql/`, and `infra/docker/`.
- Multi-tenant isolation (Postgres RLS policies, `withTenant`/`withSystem`, `app.org_id` propagation).
- Envelope encryption of secrets via `KMS_MASTER_KEY` (`packages/db`, secret-handling code paths).
- The GitHub App integration and webhook signature verification.

Out of scope:
- Third-party dependencies — report upstream first.
- LLM provider account or key management — report to the provider.
- Self-hosted deployment configurations that diverge from the defaults shipped here.
- Issues that require a malicious operator already inside the trust boundary (e.g., a tenant administrator exfiltrating their own data).

## Supported versions

Mergecrew is pre-1.0; security fixes target `main` only. Once tagged releases are cut, this section will list supported version ranges.
