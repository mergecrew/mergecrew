# Contributing to Mergecrew

Thank you for considering a contribution. Mergecrew is alpha; APIs and the database schema are not yet stable. Treat the codebase accordingly.

## Before you start

- Read the project [README](README.md) and the architecture docs in [`docs/`](docs/README.md). The architecture docs describe the system as it is — if your change requires a doc update, plan to include it in the PR.
- Check the [issue tracker](https://github.com/mergecrew/mergecrew/issues) and the [project board](https://github.com/orgs/mergecrew/projects). The roadmap items are pre-filed; pick one labeled `roadmap` if you want a substantial first contribution, or one labeled `good first issue` for a smaller starter.
- For non-trivial design changes (anything that touches the agent runtime, multi-tenancy, deploy adapters, or the human approval gate), open a [Discussion](https://github.com/mergecrew/mergecrew/discussions) first so we can align before code is written.

## Local setup

The full local-dev path is documented in the [README](README.md#quick-start). Short version:

```bash
git clone git@github.com:mergecrew/mergecrew.git
cd mergecrew
cp .env.example .env
pnpm install
pnpm compose:up         # Postgres + Redis via Docker
pnpm db:migrate
pnpm db:seed
pnpm dev                # all services in watch mode
```

You don't need any paid LLM API keys to run locally — Ollama via Homebrew works zero-cost. See the README for details.

## Submitting a change

1. Fork the repo and create a feature branch from `main`.
2. Make focused commits. Conventional-Commits-style prefixes are appreciated but not required (`feat:`, `fix:`, `docs:`, `chore:`, `refactor:`).
3. Run the local checks before opening a PR:
   ```bash
   pnpm typecheck
   pnpm build
   pnpm test --if-present
   pnpm format         # prettier
   ```
4. Open a PR against `main`. Use the [PR template](.github/PULL_REQUEST_TEMPLATE.md). Reference the issue you're closing with `Closes #N` in the body.
5. CI runs the same checks plus a Postgres + Redis integration setup. PRs must pass CI before review.

## What gets accepted

- Bug fixes with a regression test or a clear repro path.
- Documentation fixes — typos, broken links, claims that don't match the code.
- Small features that fit the existing architecture and don't require schema migrations beyond what's needed.
- Larger features that have an open issue with a maintainer's `+1` or that came out of a Discussion.

## What needs more discussion

- Changes to the agent runtime contracts (`packages/agent-runtime`, `packages/skills`).
- Changes to multi-tenancy isolation (`packages/db` `withTenant`/`withSystem`, RLS policies, `TenantInterceptor`).
- Changes that soften the production-promote human gate. This is a [non-configurable product invariant](docs/00-product/02-scope.md).
- New deploy adapters or VCS adapters — open an issue with the proposed interface fit first.
- Schema migrations that drop columns or change semantics on existing rows.

## Coding standards

- TypeScript strict mode is on. Don't disable it locally.
- One package per concern; cross-package code goes through the package's `index.ts`.
- Tenant-scoped queries MUST use `withTenant` — never raw Prisma. The runtime relies on RLS policies that depend on `app.org_id` being set, which `withTenant` does for you.
- Don't introduce a new runtime dependency without a comment explaining why a built-in or already-present library doesn't fit.
- Match the existing logging shape (`pino`, with `service` and `requestId` keys where applicable).

## Full-loop e2e test (#191)

`apps/e2e-loop` is the runnable counterpart to the unit-test suite — it spawns a real `DailyRun` against a deployed environment, polls until terminal, and asserts on workflow + step counts. The CI workflow at `.github/workflows/e2e-loop.yml` runs it daily on a schedule and skips silently when the secrets aren't configured (forks see no failure).

To enable it on a fork or staging org, set these repo / org secrets:

| Secret | Purpose |
| --- | --- |
| `MERGECREW_E2E_API_URL` | Base URL of the deployed API (e.g. `https://api.staging.mergecrew.dev`). Empty → workflow skips. |
| `MERGECREW_E2E_API_KEY` | `mc_live_…` operator-role API key. |
| `MERGECREW_E2E_ORG_SLUG` | Target organization slug. |
| `MERGECREW_E2E_PROJECT_SLUG` | Target project slug. |

The deployed runner must run with `MERGECREW_AGENT_STUB=1` so the agent loop returns a deterministic completed step instead of calling an LLM. The stub lives at `packages/agent-runtime/src/loop.ts`.

To run locally against your own dev stack:

```bash
MERGECREW_API_URL=http://localhost:3001 \
MERGECREW_API_KEY=mc_live_... \
MERGECREW_ORG_SLUG=acme \
MERGECREW_PROJECT_SLUG=demo \
  pnpm --filter @mergecrew/e2e-loop e2e
```

## Reporting bugs

Use the [Bug report](https://github.com/mergecrew/mergecrew/issues/new?template=bug_report.md) template. Include:
- Mergecrew commit SHA (`git rev-parse HEAD`)
- Node version, pnpm version, OS
- Steps to reproduce and what you expected vs. what happened
- Relevant logs from `.logs/` or pnpm dev output

## Security disclosures

See [SECURITY.md](SECURITY.md). Please do not file public issues for security-relevant findings.

## License

By contributing you agree your contribution will be licensed under the project's [Apache 2.0 License](LICENSE).
