# Quickstart: self-host mergecrew in 15 minutes

This guide takes you from `git clone` to your first agent-generated PR on a synthetic sample app. Everything runs locally in Docker; no cloud account, no paid API key, no OAuth setup.

If anything in here doesn't match what you see, jump to the [troubleshooting](#troubleshooting) table at the bottom.

## Prereqs

| Tool | Why | Install |
|---|---|---|
| Docker (with compose v2) | Runs the whole stack | [Docker Desktop](https://www.docker.com/products/docker-desktop/) |
| Git | Clone the repo | most systems already have it |
| `curl` | Sanity-check health endpoints | most systems already have it |
| GitHub Personal Access Token (optional) | Only needed if you want mergecrew to open real PRs against a repo you own. Skip for the synthetic walkthrough below. | [github.com/settings/tokens](https://github.com/settings/tokens) |

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
2. Brings up Ollama and pulls `llama3.2:3b` (~2GB; one-time, ~5min on a typical home connection).
3. Builds and starts every mergecrew service: api, orchestrator, runner, worker-cron, web.
4. Runs Prisma migrations and seeds a `demo` org + `demo@mergecrew.local` user.

If you have an Anthropic or OpenAI key handy, drop the `--profile with-ollama` flag — the stack will boot in ~30s instead of ~5min, and you'll plug your key in later.

Wait for the log line `mergecrew-web | ✓ Ready in NNNms`. The stack is up.

## 2. Open the app

```
http://localhost:3000
```

`MERGECREW_DEV_AUTO_LOGIN=true` is on by default, so you land directly on `/orgs/demo` as the seeded demo user. No magic-link email setup required.

You should see:

- A "Today" dashboard with no projects yet
- An "Anomalies" section that's empty
- A header with the org name `demo`

## 3. Configure the LLM profile

If you used `--profile with-ollama`, the bootstrap step pre-seeded an Ollama LLM profile pointing at `http://ollama:11434` — you can skip ahead to step 4.

Otherwise, in the UI:

1. Go to **Settings → LLM providers → New provider**.
2. Pick `anthropic` or `openai`. Paste your API key. Save.
3. Go to **Settings → LLM profiles**. The default profile should now show a usable model. (If it doesn't, create one and set the preferred model.)

## 4. Connect a sample repo

For the synthetic walkthrough, use **[mergecrew/quickstart-sample](https://github.com/mergecrew/quickstart-sample)** — a tiny Express app with one deliberately broken route. The sample is a synthetic; mergecrew opens its PR against a local clone so you don't need GitHub credentials.

```sh
# In a new terminal — repo will be mounted into the runner container
git clone https://github.com/mergecrew/quickstart-sample.git /tmp/quickstart-sample
```

In the UI:

1. **Projects → New project**. Slug: `quickstart`. Name: `Quickstart`.
2. Inside the project → **Connected repo**. Provider: `local`. Path: `/tmp/quickstart-sample`. Default branch: `main`.
3. **Deploy targets → New**. Kind: `dev`. Adapter: `local-noop`. (No real deploy happens; mergecrew just needs to know a dev target exists.)
4. **Lifecycle**. The default lifecycle works — Discovery → Implement → Review.

## 5. Trigger the first run

In the project header, click **Run now**.

Watch the **Timeline** tab:

- A `run.started` event appears immediately.
- Steps flow through the Discovery → Implement → Review agents. Each step's transcript is one click away.
- After ~2-5 minutes (longer on Ollama, faster on Anthropic), a `changeset.proposed` event fires.

If you got here, you have **an agentic PR ready for review**. Open the **Changesets** tab to see it.

## 6. Approve the changeset

Click into the proposed changeset. You'll see:

- The diff the agent produced
- A "Why" paragraph (agent-generated)
- A risk score (computed by the blast-radius + risk-score gates)
- Three buttons: **Approve**, **Reject**, **Defer**

Click **Approve**. Watch the changeset move to `merged` in the timeline. The PR's commit lands on the local sample repo's `main` branch.

🎉 That's the loop. You ran an entire SDLC cycle — spec → build → review → merge — driven by an agent, on a real codebase, on your laptop.

## Where to go next

- Connect a real GitHub repo (requires a GitHub App; see [`docs/03-infrastructure/01-overview.md`](03-infrastructure/01-overview.md))
- Enable **nightly evals** so regressions get caught automatically: Settings → Nightly evals → Toggle on. See [`docs/03-infrastructure/15-evals.md`](03-infrastructure/15-evals.md).
- Tighten the **monthly spend cap** before plugging in a real API key: Settings → Spend cap. See [`docs/03-infrastructure/08-monthly-spend-cap.md`](03-infrastructure/08-monthly-spend-cap.md).
- Read the **operator runbook** before you trust the system unsupervised: [`docs/03-infrastructure/05-operator-runbook.md`](03-infrastructure/05-operator-runbook.md).

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `docker compose up` hangs on `mergecrew-ollama-pull` for >10min | Slow connection, or Ollama can't reach the model registry | `docker compose logs ollama-pull`. If it's stuck, drop `--profile with-ollama` and use Anthropic/OpenAI instead. |
| Web returns 500 on first load | Migrations didn't finish before web started | `docker compose logs migrate` — should end with `Done`. If not, `docker compose restart api web` after migrate completes. |
| `Run now` button does nothing | Project is paused — no connected repo or no dev deploy target | Check **Settings → Project** for a yellow "paused" banner. Add the missing piece. |
| Agent steps fail with "no LLM profile configured" | Provider key not pasted or profile not set as default | Settings → LLM profiles. Make sure the default profile's preference order has at least one provider+model entry. |
| `localhost:3000` shows `ECONNREFUSED` | Web container booted but api didn't | `docker compose ps`. If `mergecrew-api` is in `restarting`, check its logs — usually a missing migration or env var. |
| Bucket-not-found errors from the transcript store | MinIO bucket didn't get created | `docker compose logs minio-init` — should end with `bucket ready`. Restart with `docker compose restart minio-init`. |

For deeper issues, see the [self-host runbook](03-infrastructure/16-self-host-runbook.md).
