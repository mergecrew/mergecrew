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
│  5-minute quickstart →                                │
└──────────────────────────────────────────────────────┘
```

Below it, the Today page shows the demo project `acme` with one recent completed run.

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

## 4. (Optional) Trigger your own run

If you want to watch the agents work live:

1. Make sure an LLM profile is configured. The `--profile with-ollama` flag already wired an Ollama profile at `http://ollama:11434`. Otherwise: **Settings → LLM providers → New provider**, paste your Anthropic / OpenAI key, save.
2. The demo project's lifecycle ships `Planner / Coder / Reviewer` agents on the **careful** graph profile. No editing needed.
3. From the project header, click **Run now**.

Watch the **Timeline** tab fill in real time. The Planner emits its plan (a markdown blob listing files to touch + a validation plan), the Coder produces a diff, the Reviewer parses a structured `VERDICT:` line. If the Reviewer requests changes, the Coder reruns with the feedback — up to 3 rounds before `REVIEW_LOOP_EXHAUSTED` fires and the run advances anyway (the cap is tunable via `REVIEW_LOOP_CAP`).

After ~2–5 minutes (longer on Ollama, faster on a frontier model) a new `CHANGESET_OPENED` event fires.

## 5. Connect your own repo

Once the sample run has shown you what to expect, point mergecrew at a real codebase:

```sh
# In a new terminal — the repo will be mounted into the runner container
git clone https://github.com/mergecrew/quickstart-sample.git /tmp/quickstart-sample
```

In the UI:

1. **Projects → New project**. Slug: `quickstart`. Name: `Quickstart`.
2. Inside the project → **Connected repo**. Provider: `local`. Path: `/tmp/quickstart-sample`. Default branch: `main`.
3. **Deploy targets → New**. Kind: `dev`. Adapter: `local-noop`. (No real deploy happens; mergecrew just needs to know a dev target exists.)
4. **Lifecycle**. The default lifecycle works — same careful profile as the demo project. (Settings → Agent graph if you want to switch to the cheaper single-agent `fast` profile.)
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
