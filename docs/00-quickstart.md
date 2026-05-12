# Quickstart: see mergecrew in 5 minutes

This guide takes you from `git clone` to clicking through a completed multi-agent run on the bundled demo project. Everything runs locally in Docker; no cloud account, no paid API key, no OAuth setup. You don't have to trigger a run to see the value — a sample run ships pre-baked so the UI is non-empty on first boot.

If anything in here doesn't match what you see, jump to the [troubleshooting](#troubleshooting) table at the bottom.

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
4. Runs Prisma migrations and seeds a `demo` org + `demo@mergecrew.local` user + an `acme` demo project on the **careful** multi-agent profile, plus one **pre-baked completed run** so the UI has something to render.

If you have an Anthropic or OpenAI key handy, drop the `--profile with-ollama` flag — the stack will boot in ~30s instead of ~5min, and you'll plug your key in later.

Wait for the log line `mergecrew-web | ✓ Ready in NNNms`. The stack is up.

## 2. Open the app

```
http://localhost:3000
```

`MERGECREW_DEV_AUTO_LOGIN=true` is on by default, so you land directly on `/orgs/demo` as the seeded demo user.

The first thing you should see is the **welcome card** at the top of the Today page:

```
┌──────────────────────────────────────────────────────┐
│ Welcome to mergecrew                          [Dismiss]│
│                                                       │
│ mergecrew runs an agentic development lifecycle      │
│ against your repo on a daily cadence. Each run       │
│ dispatches a planner → coder → reviewer chain and    │
│ proposes a changeset for human approval.             │
│                                                       │
│  • Open the seeded demo project to see a completed   │
│    multi-agent run …                                  │
│  • Projects is where you wire your own repo …        │
│  • The Lifecycle page edits the YAML that defines …  │
│                                                       │
│  [ Try a sample run ]   5-minute quickstart →         │
└──────────────────────────────────────────────────────┘
```

Below it, the Today page shows the demo project `acme` with one recent completed run.

The welcome card includes a **Try a sample run** primary button (#406). Clicking it triggers a fresh run on the demo project and redirects you to the live timeline within a second or two — the fastest path from "I just opened the app" to "I'm watching agents work." Section 4 walks through what happens after the click.

Just below the welcome card you'll see the **onboarding checklist banner** (#384) — five steps from a fresh install to your first real agent run on your own repo. The banner is dismissable and re-appears each time a step's state changes.

## 3. Click into the seeded sample run

Open **Projects → acme**. The project's Today tab lists one recent run — open it.

The run-detail page renders the **Agents** card with three rows: **Planner**, **Coder**, **Reviewer** — matching the V2.ae careful flow. Click any agent row to see its transcript, token spend, and (for the planner) its markdown plan.

```
Run · acme · 1h ago · done
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

That's the 5-minute path. You've seen the multi-agent flow end-to-end without triggering anything yourself.

## 4. Trigger your own run

The default compose env sets `MERGECREW_DEMO_MODE=1`, which routes every agent step through a deterministic stub instead of an LLM. That means you can trigger a run immediately — no API key, no Ollama wait, no Settings tour. An amber **Demo mode** banner at the top of the page makes the mode unambiguous.

The fastest trigger path is the **Try a sample run** button on the welcome card (back on `/orgs/demo`). It POSTs to the runNow API, pre-creates the DailyRun row, and redirects you straight to the live run-detail page so the SSE timeline starts streaming the agent steps as they happen.

Alternatively, from `/orgs/demo/projects/acme` click **Run now** on the project header — same trigger, same redirect.

Either way:

1. The page redirects to the new run's detail view.
2. Watch the **Timeline** tab fill: the Planner emits a canned markdown plan, the Coder produces a placeholder changeset, the Reviewer emits a `VERDICT: approve`.
3. A new `CHANGESET_OPENED` event appears in <2s; the resulting changeset is visible on the Changesets tab.

To switch to real agent runs:

1. Set `MERGECREW_DEMO_MODE=0` in your `.env` (or unset the var) and restart the stack.
2. Configure an LLM profile. The onboarding wizard at `/orgs/demo/onboarding` (#383) is the most discoverable path — click **Add an LLM provider** and paste your Anthropic / OpenAI key directly inline (#385). The `--profile with-ollama` flag wires Ollama automatically.
3. Click **Run now** again. The Planner takes ~30s on a frontier model, the Coder ~2-5 min depending on repo size. If the Reviewer requests changes, the Coder reruns with the feedback — up to 3 rounds before `REVIEW_LOOP_EXHAUSTED` fires and the run advances anyway (cap tunable via `REVIEW_LOOP_CAP`).

## 5. Set up your own project with the onboarding wizard

The onboarding wizard at `/orgs/demo/onboarding` (#383, V2.ah) is the canonical path for first-time setup. It walks you through five checklist steps:

1. **Add an LLM provider** — inline form, no Settings detour.
2. **Create your first project** — your own slug + name.
3. **Connect a repo** — GitHub App install or `local` adapter for a synthetic walkthrough.
4. **Add a dev deploy target** — `local-noop` if you just want to see the loop.
5. **Pick a lifecycle template** (#395, V2.ai) — opens the project's Lifecycle page where four stock templates ship out of the box: `generic-careful`, `nextjs-vercel`, `python-render`, `go-fly`. One click installs the chosen template as your project lifecycle; you can still edit the YAML after.

Each step shows pending vs complete and a one-line description of what the step buys you. Completion is computed from DB state, so closing the browser and coming back picks up where you left off.

## 6. Connect your own repo

Once the sample run has shown you what to expect, point mergecrew at a real codebase:

```sh
# In a new terminal — the repo will be mounted into the runner container
git clone https://github.com/mergecrew/quickstart-sample.git /tmp/quickstart-sample
```

In the UI (the onboarding wizard from section 5 will walk you through these, but here they are explicitly):

1. **Projects → New project**. Slug: `quickstart`. Name: `Quickstart`.
2. Inside the project → **Connected repo**. Provider: `local`. Path: `/tmp/quickstart-sample`. Default branch: `main`.
3. **Deploy targets → New**. Kind: `dev`. Adapter: `local-noop`. (No real deploy happens; mergecrew just needs to know a dev target exists.)
4. **Lifecycle**. Pick a stock template from the picker at the top of the page (#394). The `generic-careful` template is a safe default; if your repo is a Next.js / Python / Go service, the stack-specific templates tune the agent descriptions accordingly. (Settings → Agent graph if you want to switch to the cheaper single-agent `fast` profile.)
5. **Run now**.

Approve the resulting changeset from the Changesets tab when you're satisfied. The merge lands on the local sample repo's `main` branch.

🎉 That's the loop. Spec → plan → build → review → merge, agent-driven, on a real codebase, on your laptop.

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
| Today page is empty on first load (no welcome card, no demo run) | Seed didn't finish before web started | `docker compose logs seed` — should end with the `Pre-baked sample run …` line. If not, `docker compose restart seed api web`. |
| Welcome card keeps showing after dismiss | localStorage blocked by browser (incognito + certain settings) | Open the same URL in a normal-mode window. The dismiss state is per-browser-profile. |
| Run stuck on Reviewer with `REVIEW_CHANGES_REQUESTED` looping | LLM reviewer is over-eager on style; coder retries don't address it | Wait — the loop caps at 3 rounds (default). After `REVIEW_LOOP_EXHAUSTED` fires, the changeset surfaces unchanged. To raise the cap: set `REVIEW_LOOP_CAP=5` in `.env` and restart. To soften it: edit the reviewer's prompt in the project lifecycle YAML. |
| Run jumps straight to a `coder` second-round before the first finishes | Stale agent_step rows from a prior crashed run | `docker compose logs orchestrator` — look for `careful loop exhausted` or `out_of_scope_edit`. Restart with `docker compose restart orchestrator runner`. |
| Web returns 500 on first load | Migrations didn't finish before web started | `docker compose logs migrate` — should end with `Done`. If not, `docker compose restart api web` after migrate completes. |
| `Run now` button does nothing | Project is paused — no connected repo or no dev deploy target | Check **Settings → Project** for a yellow "paused" banner. Add the missing piece. |
| Agent steps fail with "no LLM profile configured" | Provider key not pasted or profile not set as default | Settings → LLM profiles. Make sure the default profile's preference order has at least one provider+model entry. |
| `localhost:3000` shows `ECONNREFUSED` | Web container booted but api didn't | `docker compose ps`. If `mergecrew-api` is in `restarting`, check its logs — usually a missing migration or env var. |
| Bucket-not-found errors from the transcript store | MinIO bucket didn't get created | `docker compose logs minio-init` — should end with `bucket ready`. Restart with `docker compose restart minio-init`. |

For deeper issues, see the [self-host runbook](03-infrastructure/16-self-host-runbook.md).
