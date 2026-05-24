# Self-host operator runbook

What to do when the *infrastructure* underneath a self-hosted Mergecrew breaks. For *application*-level failure modes (stuck step, budget exhaustion, eventlog backlog, etc.) see the [operator runbook](05-operator-runbook.md). This page is the one to read at 2am when the symptom is "the stack itself isn't running."

Each entry is symptom → likely cause → recovery → source of truth. If a symptom isn't here, start with the **Where to look first** section at the end.

## Symptoms → page

| Symptom | Where |
|---|---|
| `pnpm bootstrap` fails on a fresh install | [Bootstrap fails](#bootstrap-fails) |
| Web returns 500 right after `docker compose up` | [Migrate didn't finish before app started](#migrate-race) |
| `evals_last_ran_at column does not exist` in worker-cron logs | [Migration drift](#migration-drift) |
| Provider credential decrypt errors after a deploy | [KMS_MASTER_KEY mismatch](#kms-mismatch) |
| `Run now` hangs; runner logs show OOM | [Redis or runner OOM](#oom) |
| Ollama path: agent steps fail "no LLM response" | [Ollama timeout / model not loaded](#ollama) |
| GitHub App auth fails: "Resource not accessible by integration" | [GitHub App scopes too narrow](#github-scopes) |
| Need to rotate `KMS_MASTER_KEY` | [Rotate KMS](#rotate-kms) |
| Need to backup the DB | [Backup + restore Postgres](#backup-postgres) |
| Migrating from Ollama to Anthropic mid-project | [Switch LLM provider](#switch-llm) |
| Configure outbound email (digests, magic-link) | [Configure outbound email](#configure-email) |
| Worker stuck, want to restart safely | [Restart a worker without losing in-flight runs](#safe-restart) |
| Switch the runner to the docker sandbox driver | [Enable RUNNER_SANDBOX=docker](#runner-sandbox-docker) |

---

## Failure modes

### Bootstrap fails
<a id="bootstrap-fails"></a>

**Symptom.** `pnpm bootstrap` exits non-zero before reaching the "Bootstrap complete" line.

**Likely cause.** Common, in order of frequency:
1. `DATABASE_URL` not reachable. Postgres isn't running yet, or the host/port in `.env` is wrong.
2. `prisma generate` failed because `@prisma/client` engines couldn't unpack — usually a libssl mismatch on a non-Debian base image.
3. `.env` exists with a placeholder `KMS_MASTER_KEY` (e.g. `change-me-in-prod`). The Prisma seed step that pre-encrypts the demo provider's credential will fail at AES-GCM init.

**Recovery.**
1. Verify Postgres: `psql "$DATABASE_URL" -c 'select 1'`. If it errors with "connection refused," start Postgres first (`docker compose up -d postgres` or your own start command).
2. If `prisma generate` fails: `pnpm --filter @mergecrew/db generate` independently and inspect the error. On Alpine-based hosts, install `openssl` first (`apk add openssl ca-certificates`).
3. If KMS init complains about key shape, delete the placeholder and re-run bootstrap — the script regenerates a valid `base64:<32-bytes>` value when the key is missing.

**Source.** `scripts/bootstrap.ts` (#316).

---

### Migrate didn't finish before app started
<a id="migrate-race"></a>

**Symptom.** Web container returns 500 on first load. API logs show `relation "X" does not exist` or `column "Y" does not exist`.

**Likely cause.** The `migrate` one-shot in `docker-compose.full.yml` exits before its dependent services start — but if you bypassed compose (e.g. ran `docker run` directly on api) or used a helm chart without an init container, app services start against an unmigrated DB.

**Recovery.**
1. Compose path: `docker compose -f docker-compose.full.yml logs migrate`. The last line should be `migrate deploy complete`. If not, fix the underlying migrate failure (usually `DATABASE_MIGRATE_URL` wrong or the migrator role missing).
2. After migrate finishes, `docker compose restart api web orchestrator runner worker-cron`.
3. Helm path: add an `initContainer` to the api Deployment that runs `prisma migrate deploy`. The chart at `infra/helm/mergecrew/` (#319) does NOT do this yet — it's on the operator. Track [#xxx](https://github.com/mergecrew/mergecrew/issues) for chart-side migrate-init.

**Source.** `docker-compose.full.yml`, `packages/db/prisma/migrations/`.

---

### Migration drift
<a id="migration-drift"></a>

**Symptom.** A service (often worker-cron) crashes with `The column X does not exist in the current database` or `relation "Y" does not exist`. App code was updated to a newer schema but the DB never had the migration applied.

**Likely cause.** You pulled new code and restarted the apps without re-running migrations. Common after upgrading mergecrew between minor versions or after a feature-flag enablement that adds a column.

**Recovery.**
1. List unapplied migrations: `pnpm --filter @mergecrew/db exec prisma migrate status`. It'll print "Database schema is out of sync" with the names of the unapplied entries.
2. Apply: `pnpm --filter @mergecrew/db migrate` (= `prisma migrate deploy`). Safe to run multiple times — applied migrations are skipped.
3. Restart the failing service.

**Prevention.** In production, run `prisma migrate deploy` as a deploy-pipeline step *before* rolling new app images. In helm, an `initContainer` on the api Deployment is the simplest pattern.

**Source.** `packages/db/prisma/migrations/`.

---

### KMS_MASTER_KEY mismatch
<a id="kms-mismatch"></a>

**Symptom.** All decryption fails after a redeploy: provider credentials, secrets, anything stored as ciphertext. Logs show `AES-GCM: decrypt failed: bad auth tag` or `decryptDevOnly: invalid base64 key`.

**Likely cause.** `KMS_MASTER_KEY` changed between deploys. AES-GCM ciphertext written under key A cannot be read under key B. There's no recovery without either restoring the old key or re-encrypting every ciphertext column.

**Recovery.**
1. **If you still have the old key** (e.g. it's in another env file, a previous Secret revision in k8s): roll back the `KMS_MASTER_KEY` env to the old value. Everything decrypts again. Then plan a proper rotation (see [Rotate KMS](#rotate-kms)).
2. **If the old key is genuinely gone**: every stored credential is dead. You'll need to:
   - Restore the DB from backup if one exists from before the rotation.
   - Re-add every LLM provider credential, GitHub App private key, OAuth secret, etc. through the UI.
   - Audit the audit log to confirm no encrypted-only data is silently lost.

**Prevention.** Treat `KMS_MASTER_KEY` like a primary database password. Store it in a real secret manager, not in `.env` files that get rotated out of band.

**Source.** `apps/runner/src/step.ts` (`decryptDevOnly`), `packages/db/src/encryption.ts`.

---

### Redis or runner OOM
<a id="oom"></a>

**Symptom.** Runs queue but never start, or steps go `running` and never complete. `docker stats` shows redis or runner at >95% of its limit. Container restarts every few minutes.

**Likely cause.** The runner's resource limit is too tight for the agent workload, or Redis is filling with stuck/orphaned BullMQ keys.

**Recovery.**
1. Compose: bump `RUNNER_MEM_LIMIT` in `.env` (default 1g) or remove the limit entirely while diagnosing. Restart.
2. Kubernetes: bump `resources.limits.memory` in `infra/helm/mergecrew/values.yaml` for the runner.
3. Redis: `redis-cli info memory`. If `used_memory_peak` is near `maxmemory`, the eviction policy is probably wrong — set `maxmemory-policy` to `noeviction` (so BullMQ keys can't be evicted under load) OR increase the Redis memory budget.
4. If you find stuck BullMQ keys, the safe move is to drain affected queues from the UI rather than `FLUSHALL` — see the [BullMQ cleanup recipe](#bullmq-cleanup).

**Source.** `infra/helm/mergecrew/values.yaml`, `docker-compose.prod.yml`.

---

### Ollama timeout / model not loaded
<a id="ollama"></a>

**Symptom.** Agent steps fail with `no response from LLM` or hang for the agent's configured timeout. `docker compose logs ollama` shows `model not loaded` or `request timeout`.

**Likely cause.** Common, in order:
1. Model not pulled. The `with-ollama` compose profile (#315) runs `ollama-pull` once; if it failed silently the model is missing.
2. First request after restart — Ollama lazy-loads weights into RAM. The first inference can take 30-90s.
3. Host doesn't have enough RAM. `llama3.2:3b` needs ~3GB; if the OS swaps, requests time out.

**Recovery.**
1. `docker compose exec ollama ollama list` — confirms the model is present. If not, `docker compose run --rm ollama-pull` or manually `docker compose exec ollama ollama pull llama3.2:3b`.
2. Bump the agent's `timeoutMs` in `mergecrew.yaml` if the model is slow on your hardware.
3. Switch to a smaller model: edit the LLM profile's preference order in **Settings → LLM profiles** to use a 1B or 1.5B param model.

**Source.** `packages/llm/src/models.ts` (Ollama client), `docker-compose.full.yml` (profile config).

---

### GitHub App scopes too narrow
<a id="github-scopes"></a>

**Symptom.** Agent steps that touch GitHub fail with `Resource not accessible by integration`. PR opening or branch creation aborts. Inbox shows changesets stuck at `pending_pr_create`.

**Likely cause.** Your GitHub App is installed on the target repo but doesn't have the permissions mergecrew needs.

> First time setting up the App? Walk through [GitHub App setup](20-github-app-setup.md) — the Setup URL, webhook, and permissions are documented end-to-end there. If after install the user gets stuck on `github.com/.../settings/installations/<id>`, the App is missing its Setup URL.

**Required permissions** (set under your GitHub App settings → Permissions → Repository permissions):

| Permission | Access level |
|---|---|
| Actions | Read & write (for GitHub Actions deploy adapter) |
| Administration | Read-only (for branch protection introspection) |
| Checks | Read & write |
| Contents | Read & write |
| Issues | Read & write |
| Metadata | Read-only (always required) |
| Pull requests | Read & write |
| Workflows | Read & write |

**Recovery.**
1. Update the App permissions in github.com/settings/apps.
2. The change requires the installation to be re-authorized: in the org's installation settings, click "Review request" and accept the new scopes.
3. Retry the failing step from the UI.

**Source.** `apps/runner/src/step.ts` for the GitHub call sites; `packages/adapters-vcs/src/github.ts` for the App auth flow.

### Enable RUNNER_SANDBOX=docker
<a id="runner-sandbox-docker"></a>

> **Tenancy note.** `RUNNER_SANDBOX` now configures the **instance-builtin** runner profile only. It applies to orgs listed in `MERGECREW_TRUSTED_ORG_SLUGS` (or the implicit `MERGECREW_OWNER_ORG_SLUG`); other orgs default to the `none` profile and must bring their own runner. See [ADR-0006](../adrs/0006-trusted-org-gating.md) and [ADR-0008](../adrs/0008-default-profile-none.md).

**Symptom.** Default install runs in *unsandboxed mode* — supervisor startup logs a multi-line banner with the title `UNSANDBOXED RUNNER MODE` and a warning. Build steps for every tenant execute on the supervisor host. Suitable for single-tenant self-hosters; unsuitable for multi-tenant.

**Cause.** `RUNNER_SANDBOX` defaults to `process` (the ProcessDriver) for two reasons: zero install dependencies (no Docker socket required on the supervisor host) and complete behavioral parity with the V0 runner. Operators flip it deliberately once they have the host setup ready.

**Recovery — flipping to docker.**

1. **Confirm the supervisor has access to a Docker socket.** Either bind-mount `/var/run/docker.sock` into the supervisor container, or run the supervisor on a host with a Docker socket available. `docker info` from within the supervisor process must work.
2. **Ensure CAP_CHOWN** (or run the supervisor as root inside its container). The docker driver chowns the workspace to uid 1001 before `docker run`; without CAP_CHOWN the build will surface EACCES. See [`docs/03-infrastructure/22-runner-images.md`](22-runner-images.md) § "Workspace ownership (host side)".
3. **Set the env.** Add to the supervisor's environment:

   ```sh
   RUNNER_SANDBOX=docker
   # optional:
   RUNNER_DEFAULT_IMAGE=ghcr.io/mergecrew/runner-node:20
   RUNNER_OCI_RUNTIME=runsc           # gVisor; default 'runc' is fine for most
   RUNNER_DOCKER_BIN=podman           # for rootless/podman setups
   ```

4. **Restart the supervisor.** Startup log now shows `sandboxDriver: 'docker'` and the unsandboxed banner is gone.
5. **Run a smoke step.** The first per-tenant build run pulls the stock image (or the `runner.image` from `mergecrew.yaml`). First-time cold pull adds ~10s; subsequent runs reuse the cached image.

**Verification.** Inside the running container during a build step:

```sh
docker exec <container-id> id          # uid=1001 gid=1001
docker exec <container-id> printenv KMS_MASTER_KEY    # empty (env scrub, #561)
docker exec <container-id> ip addr show               # --network none until Phase 4
```

**Rollback.** Unset `RUNNER_SANDBOX` (or set to `process`) and restart the supervisor. No data migration needed; the workspaces and skill API are unchanged.

**Source.** `apps/runner/src/main.ts` builds the driver via `buildSandboxDriver()` from `RUNNER_SANDBOX`. Factory: `packages/sandbox-driver/src/factory.ts`. RFC: `docs/02-architecture/13-runner-isolation.md` § 7.

---

### Trust an org for the instance-builtin runner profile
<a id="trusted-orgs"></a>

**Symptom.** A new org signs up on the deployment but can't pick `instance-builtin` for its runner profile — the option is greyed out in the UI, and a direct PATCH returns 403.

**Cause.** Per [ADR-0006](../adrs/0006-trusted-org-gating.md), only orgs listed in `MERGECREW_TRUSTED_ORG_SLUGS` (plus the implicit `MERGECREW_OWNER_ORG_SLUG`) may select `instance-builtin` — everyone else must BYO via the runner-agent or the `fargate-byo` profile.

**Recovery.**

1. Add the slug to one of the envs:

   ```sh
   # Comma-separated for the multi-org case.
   MERGECREW_TRUSTED_ORG_SLUGS=acme,beta
   # Single-org installs typically set just the owner slug:
   MERGECREW_OWNER_ORG_SLUG=acme
   ```

2. Restart the API (the env is read per-request, but the value is captured at startup time in some deployment topologies — safer to redeploy).
3. The org's runner-profile settings page now shows `instance-builtin` as a selectable option. Server-side validation gates the PATCH endpoint on the same env, so a UI bypass attempt returns 403.

**Verification.** `GET /api/v1/orgs/<slug>/runner-profile` returns `isTrustedForInstanceBuiltin: true` for trusted orgs and `false` otherwise.

**Source.** `apps/api/src/common/trusted-orgs.ts` exposes `isTrustedOrgSlug()`. ADRs: [0006](../adrs/0006-trusted-org-gating.md), [0008](../adrs/0008-default-profile-none.md).

---

### Upgrading from v0 single-queue to V2.af per-profile queues
<a id="runner-queue-migration"></a>

**What changed.** The supervisor's BullMQ queue was renamed from `runner.step` to `runner.step.instance` ([ADR-0005](../adrs/0005-per-profile-queues.md)). The orchestrator now reads each org's `runner_profile.kind` and routes the step to either `runner.step.instance` (for trusted `instance_builtin` orgs) or a per-org agent queue `runner.step.agent.<orgId>` (consumed by the API's long-poll endpoint, lands in #766).

**What this means for v0 operators.** Single-org deployments don't need any change beyond adding the org slug to `MERGECREW_TRUSTED_ORG_SLUGS` or `MERGECREW_OWNER_ORG_SLUG` (see § "Trust an org for the instance-builtin runner profile" above). The migration in #761 backfilled every pre-existing org to `kind='instance_builtin'`, so the supervisor's behavior is byte-identical.

**Bridge worker.** A one-release back-compat worker in `apps/runner/src/main.ts` consumes any leftover jobs from the legacy `runner.step` queue and processes them with the same handler used for `runner.step.instance`. It logs a warning on every job picked up so operators can confirm the legacy queue has drained. The bridge worker is removed in the next minor release.

**Verification.** After deploy:

```sh
# Both queues exist; new dispatches land in the renamed queue.
redis-cli -u "$REDIS_URL" zcard bull:runner.step:waiting        # should trend to 0
redis-cli -u "$REDIS_URL" zcard bull:runner.step.instance:waiting

# Per-org agent queues appear lazily when an org with kind=agent dispatches.
redis-cli -u "$REDIS_URL" keys 'bull:runner.step.agent.*'
```

**Source.** `apps/orchestrator/src/orchestrator.ts:enqueueRunnerStep` is the dispatch chokepoint. ADR: [0005](../adrs/0005-per-profile-queues.md).

---

### BYO runner agent — enrol your first agent
<a id="byo-runner-agent"></a>

The `mergecrew/runner-agent` image lets an org execute its own runs on its own machine instead of the deployment's compute (ADR-0002). After [#765](https://github.com/mergecrew/mergecrew/issues/765) the agent can authenticate against a deployment and surface as "online" in the org settings UI. Live job pull lands in [#766](https://github.com/mergecrew/mergecrew/issues/766).

**1. Issue an enrollment token.**

Org admin → **Settings → Runner agents → Enrol agent**. Name it after the host that will run it (e.g. `homelab-1`, `eu-west-1-fargate`). The token is shown exactly once — copy it before closing the modal.

**2. Run the agent.**

```sh
docker run --rm \
  --name mergecrew-runner-agent \
  -v /var/run/docker.sock:/var/run/docker.sock \
  ghcr.io/mergecrew/runner-agent:latest \
    --token mca_<orgSlug>_XXXXXXXXXXXXXXXXXXXXXXXXXX \
    --api-url https://mergecrew.dev \
    --name homelab-1 \
    --driver docker
```

The agent logs `agent online` once it reaches the API and bumps `lastSeenAt` every 60 s. The org settings page shows the agent as **online** within one heartbeat cycle (badge UX lands in [#767](https://github.com/mergecrew/mergecrew/issues/767)).

**3. Switch the org to the agent runner profile.**

Until [#767](https://github.com/mergecrew/mergecrew/issues/767) lands the runner-profile editor, the org's `runner_profiles.kind` column has to be flipped to `agent` by direct DB edit:

```sql
update runner_profiles set kind = 'agent' where organization_id = '<org-uuid>';
```

After [#767](https://github.com/mergecrew/mergecrew/issues/767) you'll do this from the UI.

**4. Revoking.**

**Settings → Runner agents → Revoke** sets `revoked_at`; the next agent call fails 401 and the process exits 4. Audit log entries land for both `runnerAgent.created` and `runnerAgent.revoked`.

**Validate config without committing.**

```sh
docker run --rm ghcr.io/mergecrew/runner-agent:latest --help

docker run --rm ghcr.io/mergecrew/runner-agent:latest \
  --token mca_test_xxxxxx \
  --api-url https://mergecrew.dev \
  --dry-run
```

A standalone `docs/03-infrastructure/34-runner-agent.md` lands with [#766](https://github.com/mergecrew/mergecrew/issues/766) (network posture, troubleshooting, systemd unit).

---

## Recipes

### Rotate KMS_MASTER_KEY
<a id="rotate-kms"></a>

The current `decryptDevOnly` path doesn't support multiple keys at once — there's no `KMS_PREVIOUS_KEY` fallback. A rotation is a re-encrypt operation, not a key swap.

```sh
# 1. Generate a new key
NEW_KEY="base64:$(openssl rand -base64 32)"
echo "$NEW_KEY"  # save this in your secrets manager BEFORE proceeding

# 2. Stop the api + runner (keeps writes from racing the rotation)
docker compose stop api runner orchestrator worker-cron

# 3. Run the re-encrypt script (NOT YET IMPLEMENTED — tracked separately)
#    For now, the safe path is to manually re-add every encrypted secret
#    after the swap, using the UI. There's no in-place re-encrypt today.

# 4. Update KMS_MASTER_KEY in your env
sed -i "s|^KMS_MASTER_KEY=.*|KMS_MASTER_KEY=$NEW_KEY|" .env

# 5. Restart
docker compose up -d
```

**Status.** An in-place re-encrypt script is not yet shipped. Until it is, a rotation means "re-add every credential through the UI."

### Backup + restore Postgres
<a id="backup-postgres"></a>

```sh
# Backup (host-side; compose stack must be running)
docker compose exec -T postgres pg_dump -U mergecrew -Fc mergecrew > mergecrew-$(date +%Y%m%d).dump

# Restore into a fresh DB
docker compose down -v   # wipes the existing volume
docker compose up -d postgres
sleep 5
cat mergecrew-YYYYMMDD.dump | docker compose exec -T postgres pg_restore -U mergecrew -d mergecrew --clean --if-exists
docker compose up -d
```

The pg_dump above captures schema + data. The pgvector embeddings come through transparently. RLS policies survive because they're DDL.

### Configure outbound email (Resend or SMTP)
<a id="configure-email"></a>

Mergecrew sends two kinds of outbound email: magic-link sign-ins and the daily digest. Both share one provider config in `packages/adapters-comms/src/env.ts`. Two transports are wired today: SMTP and Resend.

**Resend (recommended for self-hosted small teams):**

```env
EMAIL_PROVIDER=resend
RESEND_API_KEY=re_xxxxxxxxxxxxxxxxxxxxxxxx
MERGECREW_EMAIL_FROM=noreply@yourdomain.com  # must be a verified Resend domain
```

**SMTP (for an existing relay or self-hosted MTA):**

```env
EMAIL_PROVIDER=smtp
SMTP_URL=smtps://user:pass@smtp.example.com:465
MERGECREW_EMAIL_FROM=noreply@yourdomain.com
```

`EMAIL_PROVIDER=auto` (default) picks Resend if `RESEND_API_KEY` is set, otherwise SMTP. Setting neither disables email entirely — the orchestrator's `emailEnabledFromEnv()` gate short-circuits the digest worker and magic-link send, so no jobs queue up waiting for a configuration that will never arrive.

**Verify:** trigger a magic-link login (`/login` → "Continue with email") and watch `apps/api` logs for `magicLink: sent`. A Resend misconfiguration surfaces as a 403 in the logs; an SMTP misconfiguration as an ETIMEDOUT or `auth failed`. The `EmailClient` doesn't retry — there's no inbox spam if a config is wrong.

**Source.** `packages/adapters-comms/src/email.ts`, `packages/adapters-comms/src/env.ts`.

---

### Switch LLM provider for an existing project
<a id="switch-llm"></a>

Switching providers mid-project is safe — runs are stateless across the provider boundary, and prompts are stored alongside the model invocations, not in the agent code.

1. Settings → LLM providers → add the new provider (Anthropic / OpenAI / Bedrock) with its API key.
2. Settings → LLM profiles. Either edit the active profile to put the new provider at the top of the preference order, OR create a new profile and set it as the project default in project settings.
3. The next run picks up the new provider. No data migration is needed.

**Watch for:** the new provider's `effectiveAt` price row needs to exist in `model_price_table` for cost tracking to work. The seed includes major Anthropic / OpenAI / Bedrock / Ollama entries; for an exotic model, add a row via SQL.

### Restart a worker without losing in-flight runs
<a id="safe-restart"></a>

The runner uses BullMQ with `removeOnComplete: 1000`. In-flight jobs survive a SIGTERM as long as you let the worker drain:

```sh
# 1. Signal the worker to stop accepting new jobs but finish active ones.
docker compose stop --timeout 60 runner

# 2. Confirm: redis-cli zcard bull:runner.step:active → 0 means all active jobs drained.

# 3. Start it back up.
docker compose start runner
```

If a job is stuck for longer than the stop timeout, Docker sends SIGKILL. The orchestrator's heartbeat sweeper (see [`05-operator-runbook.md#step-stuck-running`](05-operator-runbook.md#step-stuck-running)) will re-dispatch the orphan within `ORCHESTRATOR_HEARTBEAT_STALE_AFTER_MS` (default 90s).

### BullMQ queue cleanup
<a id="bullmq-cleanup"></a>

A wedged queue can usually be drained without nuking Redis state. From the UI: Org settings → Queues → pick the queue → "Drain stuck." For SQL-level emergencies:

```sh
# List queue names + sizes
docker compose exec redis redis-cli --no-raw -c "EVAL \"return redis.call('keys', 'bull:*:wait')\" 0"

# Drain a specific queue (replace <queue>)
docker compose exec redis redis-cli DEL bull:<queue>:wait bull:<queue>:active bull:<queue>:delayed bull:<queue>:failed
```

`FLUSHALL` against the whole Redis is a nuclear option — it kills BullMQ progress markers, scheduling state, and any pubsub messages in flight. Only use it on a fresh dev instance.

---

## Where to look first

When the symptom isn't in the table above:

### Per-service logs

| Service | Compose | Kubernetes |
|---|---|---|
| api | `docker compose logs api` | `kubectl logs deploy/mergecrew-api` |
| orchestrator | `docker compose logs orchestrator` | `kubectl logs deploy/mergecrew-orchestrator` |
| runner | `docker compose logs runner` | `kubectl logs deploy/mergecrew-runner` |
| worker-cron | `docker compose logs worker-cron` | `kubectl logs deploy/mergecrew-worker-cron` |
| web | `docker compose logs web` | `kubectl logs deploy/mergecrew-web` |

Add `--since 10m --tail=200` to scope the noise.

### Postgres tables worth reading

| Table | What it tells you |
|---|---|
| `audit_logs` | Every state-changing action with actor + payload (retention 90d via worker-cron) |
| `daily_runs` | Run-level lifecycle: status, started_at, finished_at, failure_reason |
| `agent_steps` | Per-step status, heartbeat_at, attempts, failure_reason |
| `llm_invocations` | One row per model call: tokens, usd, latency_ms |
| `eval_runs` | Nightly eval pass-rate over time (#298–305) |
| `webhook_deliveries` | Outbound webhook status, retries, response codes |

### Redis keys worth knowing

| Key pattern | What it is |
|---|---|
| `bull:<queue>:wait` | Waiting jobs |
| `bull:<queue>:active` | Currently-processing jobs |
| `bull:<queue>:delayed` | Delayed jobs (sorted set, score = ms timestamp) |
| `bull:<queue>:failed` | Failed jobs with retry exhausted |
| `mergecrew:run:cancel:<runId>` | Pubsub channel — orchestrator publishes here when a user cancels |

---

## Related

- [Operator runbook](05-operator-runbook.md) — application-level failures (stuck step, budget exhaustion, etc.)
- [Observability](04-observability.md) — `/healthz`, `/readyz`, `/metrics`
- [Anomaly digest](14-anomaly-digest.md) — what the digest tells you about app health
- [Evals](15-evals.md) — debugging an eval regression
