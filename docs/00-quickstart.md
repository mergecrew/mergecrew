# Quickstart: see mergecrew in 5 minutes

This guide takes you from `git clone` to clicking through a completed multi-agent run on the bundled demo project. Everything runs locally in Docker; no cloud account, no paid API key, no OAuth setup. You don't have to trigger a run to see the value — a sample run ships pre-baked so the UI is non-empty on first boot.

If anything in here doesn't match what you see, jump to the [troubleshooting](#troubleshooting) table at the bottom.

## What is mergecrew?

mergecrew runs an **agentic development lifecycle** against your repo on a daily cadence. Each run dispatches a planner → coder → reviewer chain and proposes a changeset for human approval. Production promotion always requires a human decision — that's a product invariant, not a setting.

The Today page surfaces five things: the day's run, pending approvals, open changesets, recent activity, and the per-org setup checklist while you're still onboarding.

## Prereqs

| Tool | Why | Install |
|---|---|---|
| Docker (with compose v2) | Runs the whole stack | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| Git | Clone the repo | most systems already have it |
| `curl` | Sanity-check health endpoints (optional) | most systems already have it |

No Node, no pnpm, no Postgres install. The container build pulls a working pnpm + Node 22.

If you're a *contributor* who wants to hack on the code with hot reload, follow `README.md`'s **Hacking on the code** section instead — that path uses `pnpm dev` against host-installed Node + Postgres in Docker.

## 1. Clone and start the stack

```sh
git clone https://github.com/mergecrew/mergecrew.git
cd mergecrew
docker compose -f docker-compose.full.yml --profile with-ollama up
```

What this does:

1. Brings up Postgres (with pgvector), Redis, MinIO (S3-compatible).
2. Brings up Ollama and pulls `llama3.2:3b` (~2GB; one-time, ~5 min on a typical home connection).
3. Builds and starts every mergecrew service: api, orchestrator, runner, worker-cron, web.
4. Runs Prisma migrations and seeds a `demo` org + `demo@mergecrew.local` user + a read-only `demo-saas` project on the **careful** multi-agent profile, plus one **pre-baked completed run** so the UI has something to render.

If you have an Anthropic or OpenAI key handy, drop the `--profile with-ollama` flag — the stack will boot in ~30s instead of ~5min, and you'll plug your key in later.

Wait for the log line `mergecrew-web | ✓ Ready in NNNms`. The stack is up.

## 2. Land in the demo project

```
http://localhost:3000
```

`MERGECREW_DEV_AUTO_LOGIN=true` is on by default, so you sign in directly as the seeded demo user. New orgs land **straight in the demo project** at `/orgs/{slug}/projects/demo-saas` — a read-only sandbox prepopulated with a completed multi-agent run, three agent steps, a changeset, and the timeline events a real run produces.

A guided **coachmark tour** (`react-joyride`-style overlay, powered by `driver.js`) auto-starts on first visit and walks you through:

1. The project header (`DEMO` chip + read-only banner)
2. The latest run card
3. The pending-approvals queue
4. The open changesets
5. The lifecycle YAML link
6. The **Set up your own project →** CTA that drops you into the wizard

Skip or replay anytime via the **Replay tour** link on the read-only banner. The tour is gated on the `Project.demo` flag (#437) and tracked in `localStorage`.

The amber **Demo mode** banner along the top of every page makes the `MERGECREW_DEMO_MODE=1` state unambiguous: agent steps are routed through a deterministic stub, no LLM is contacted, and the demo project accepts trigger-run requests so you can watch the whole loop fire without setup.

## 3. Click through the seeded sample run

The Today tab on `/orgs/demo/projects/demo-saas` lists one recent run — open it.

The run-detail page renders the **Agents** card with three rows: **Planner**, **Coder**, **Reviewer** — matching the careful flow. Click any agent row to see its transcript, token spend, and (for the planner) its markdown plan.

```
Run · demo-saas · 1h ago · done
┌─ Agents ─────────────────────────────────────────────┐
│  Planner    done    2,810 tok   $0.08                │
│  Coder      done   17,300 tok   $0.51                │
│  Reviewer   done    5,120 tok   $0.06   ✓ approved   │
└──────────────────────────────────────────────────────┘
┌─ Changeset ──────────────────────────────────────────┐
│  Fix /healthz regression on the API service          │
│  status: dev_deployed · risk: low · branch: sample/… │
└──────────────────────────────────────────────────────┘
```

The **Timeline** tab shows the underlying event stream — `RUN_STARTED`, `WORKFLOW_STARTED`, three pairs of `AGENT_STEP_STARTED` + `AGENT_STEP_COMPLETED`, `PLAN_PROPOSED`, `REVIEW_APPROVED`, `CHANGESET_OPENED`, `CHANGESET_DEV_DEPLOYED`, `WORKFLOW_COMPLETED`, `RUN_COMPLETED`. This is the canonical record of what the agents did.

The **Changesets** tab shows the resulting changeset. The seed ships it as `dev_deployed` so you can see the full lifecycle from proposal through dev deploy.

## 4. Trigger your own run on the demo

Under the default compose env, `MERGECREW_DEMO_MODE=1` routes every agent step through a deterministic stub instead of an LLM. The backend's read-only guard (#438) makes a single exception for this mode so the demo project accepts new runs — that's how the FTE stays clickable without any API keys.

From `/orgs/demo/projects/demo-saas` click **Run now** on the project header (only visible under demo mode). The page redirects to the new run's detail view; watch the **Timeline** tab fill as the Planner emits a canned plan, the Coder produces a placeholder changeset, the Reviewer emits a `VERDICT: approve`.

In production deployments — `MERGECREW_DEMO_MODE` unset — the demo project is fully read-only (#438) and the trigger-run button is hidden (#439). Set up your own project to see real runs.

## 5. Set up your own project with the wizard

The **Set up your own project →** CTA on the demo's read-only banner drops you into the onboarding wizard at `/orgs/demo/onboarding`. It walks you through five checklist steps:

1. **Add an LLM provider** — inline form, no Settings detour. Anthropic, OpenAI, AWS Bedrock, or Ollama.
2. **Create your first project** — your own slug + name.
3. **Connect a repo** — GitHub App install or `local` adapter for a synthetic walkthrough.
4. **Add a dev deploy target** — `local-noop` if you just want to see the loop.
5. **Pick a lifecycle template** — opens the project's Lifecycle page where four stock templates ship out of the box: `generic-careful`, `nextjs-vercel`, `python-render`, `go-fly`. One click installs the chosen template as your project lifecycle; you can still edit the YAML after.

Each step shows pending vs complete and a one-line description of what it buys you. Completion is computed from DB state (filtered on `Project.demo === false` so the seeded `demo-saas` doesn't pre-complete steps), so closing the browser and coming back picks up where you left off.

A quiet "Or skip for now — explore the demo project →" link in the wizard footer lets you bounce back to the sandbox without losing your place.

## 6. Connect your own repo

Once the sample run has shown you what to expect, point mergecrew at a real codebase:

```sh
# In a new terminal — the repo will be mounted into the runner container
git clone https://github.com/mergecrew/quickstart-sample.git /tmp/quickstart-sample
```

The wizard from section 5 covers these explicitly, but for reference:

1. **Projects → New project**. Slug: `quickstart`. Name: `Quickstart`.
2. Inside the project → **Connected repo**. Provider: `local`. Path: `/tmp/quickstart-sample`. Default branch: `main`.
3. **Deploy targets → New**. Kind: `dev`. Adapter: `local-noop`. (No real deploy happens; mergecrew just needs to know a dev target exists.)
4. **Lifecycle**. Pick a stock template from the picker at the top of the page. The `generic-careful` template is a safe default; if your repo is a Next.js / Python / Go service, the stack-specific templates tune the agent descriptions accordingly. (Settings → Agent graph if you want to switch to the cheaper single-agent `fast` profile.)
5. **Run now**.

Approve the resulting changeset from the Changesets tab when you're satisfied. The merge lands on the local sample repo's `main` branch.

🎉 That's the loop. Spec → plan → build → review → merge, agent-driven, on a real codebase, on your laptop.

## The demo project (`demo-saas`)

Every new org receives its own `demo-saas` project (`Project.demo === true`, #437). It contains a completed planner → coder → reviewer run with three agent steps, one changeset, and the full set of timeline events a real run produces. It's the anchor for the coachmark tour and the FTE landing target.

**Read-only by default.** In production-style deployments the backend rejects mutations (`POST /runs`, lifecycle edits, settings writes, etc.) with `403 demo_project_readonly`. The UI mirrors this by hiding mutation controls and showing a "DEMO" chip. `MERGECREW_DEMO_MODE=1` (the local-compose path) opts out so the demo stays runnable for the click-to-try experience.

**Disable demo seeding.** Self-hosters who want a fully clean install can set `MERGECREW_SEED_DEMO_PROJECT=0`. New orgs created with the flag off land directly on the wizard instead of a demo project. The flag only affects per-org seeding via `OrgService.create` — the global compose seed always seeds `demo-saas` on the `demo` org.

## Where to go next

- Connect a real GitHub repo (requires a GitHub App; see [`docs/03-infrastructure/01-overview.md`](03-infrastructure/01-overview.md))
- Read the **multi-agent cookbook**: [`docs/03-infrastructure/18-multi-agent.md`](03-infrastructure/18-multi-agent.md) — how to pick `fast`/`careful`/`custom`, how to write a custom graph, how to debug a stuck reviewer loop.
- Enable **nightly evals** so regressions get caught automatically: Settings → Nightly evals → Toggle on. See [`docs/03-infrastructure/15-evals.md`](03-infrastructure/15-evals.md).
- Tighten the **monthly spend cap** before plugging in a real API key: Settings → Spend cap. See [`docs/03-infrastructure/08-monthly-spend-cap.md`](03-infrastructure/08-monthly-spend-cap.md).
- Read the **operator runbook** before you trust the system unsupervised: [`docs/03-infrastructure/05-operator-runbook.md`](03-infrastructure/05-operator-runbook.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `docker compose up` hangs on `mergecrew-ollama-pull` for >10min | Slow connection, or Ollama can't reach the model registry | `docker compose logs ollama-pull`. If it's stuck, drop `--profile with-ollama` and use Anthropic/OpenAI instead. |
| Today page is empty on first load (no setup card, no demo project) | Seed didn't finish before web started | `docker compose logs seed` — should end with the `pre-baked sample run …` line. If not, `docker compose restart seed api web`. |
| Coachmark tour doesn't auto-start | Local storage already has the completion key, or the page isn't a demo project | Click **Replay tour** in the read-only banner, or clear `localStorage` for the origin. Tour is gated on `project.demo === true`. |
| Run stuck on Reviewer with `REVIEW_CHANGES_REQUESTED` looping | LLM reviewer is over-eager on style; coder retries don't address it | Wait — the loop caps at 3 rounds (default). After `REVIEW_LOOP_EXHAUSTED` fires, the changeset surfaces unchanged. To raise the cap: set `REVIEW_LOOP_CAP=5` in `.env` and restart. To soften it: edit the reviewer's prompt in the project lifecycle YAML. |
| Run jumps straight to a `coder` second-round before the first finishes | Stale agent_step rows from a prior crashed run | `docker compose logs orchestrator` — look for `careful loop exhausted` or `out_of_scope_edit`. Restart with `docker compose restart orchestrator runner`. |
| Web returns 500 on first load | Migrations didn't finish before web started | `docker compose logs migrate` — should end with `Done`. If not, `docker compose restart api web` after migrate completes. |
| Project / lifecycle pages 404 on a slug that should exist | Demo project was renamed `acme` → `demo-saas` (#437) in a prior release | Update bookmarks. Stale `/projects/acme` links return a real 404 (#435) instead of a 500. |
| `Run now` button does nothing or 403s | Demo project in production mode (`MERGECREW_DEMO_MODE` unset) — read-only enforcement (#438) | Expected. Set up your own project from the wizard to trigger real runs. |
| Agent steps fail with "no LLM profile configured" | Provider key not pasted or profile not set as default | Settings → LLM profiles. Make sure the default profile's preference order has at least one provider+model entry. |
| `localhost:3000` shows `ECONNREFUSED` | Web container booted but api didn't | `docker compose ps`. If `mergecrew-api` is in `restarting`, check its logs — usually a missing migration or env var. |
| Bucket-not-found errors from the transcript store | MinIO bucket didn't get created | `docker compose logs minio-init` — should end with `bucket ready`. Restart with `docker compose restart minio-init`. |

For deeper issues, see the [self-host runbook](03-infrastructure/16-self-host-runbook.md).

## Multi-tenant: BYO runner

If you invite a second org to your deployment, that org won't have access to the operator's runner by default — it needs to **bring its own runner** (V2.af / [ADR-0002](adrs/0002-per-org-runner-profile.md)). Two BYO options:

- **Runner agent** — the org runs the [`mergecrew/runner-agent`](03-infrastructure/34-runner-agent.md) container on its own machine; jobs are pulled over HTTPS.
- **AWS Fargate** — the org's [own AWS account](03-infrastructure/35-runner-fargate-byo.md) via STS role assumption; no AWS keys leave the user's account.

Single-tenant self-host (the path above) needs no extra config — the demo org is implicitly trusted via the seeded `runner_profile=instance_builtin`. The trusted-org allowlist is documented in [16-self-host-runbook.md § Trust an org for the instance-builtin runner profile](03-infrastructure/16-self-host-runbook.md#trusted-orgs).
