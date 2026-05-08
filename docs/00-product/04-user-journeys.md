# User journeys

End-to-end flows for the personas. Each journey lists the actor, the steps, and the system surfaces involved.

> Some journeys describe target UX that isn't fully implemented yet; check `05-features.md` for current implementation status.

## J1 — First-run onboarding (Theo, day zero)

1. Theo signs up with GitHub OAuth. Org is auto-created from his GitHub username; he can rename it.
2. He installs the Mergecrew GitHub App on the repo for his existing SaaS.
3. Mergecrew clones the repo into a sandboxed workspace and runs **Project Inception** — a one-time analysis pass:
   - Detects stack (NestJS API + Next.js web + Prisma + PostgreSQL).
   - Detects existing CI: `.github/workflows/deploy-dev.yml`, `.github/workflows/deploy-prod.yml`.
   - Detects existing test scripts in `package.json`.
   - Generates a draft `mergecrew.yaml` at the repo root summarizing what it found and proposing a default lifecycle.
4. Theo opens the **Project setup wizard**:
   - Confirms the deploy adapter (GitHub Actions, with the dev-deploy workflow filename pre-filled).
   - Pastes any required env-var contracts (Mergecrew offers to import from `.env.example`).
   - Picks an LLM provider profile: "Anthropic primary, Bedrock fallback" (default) or others.
   - Reviews the proposed default lifecycle and human-gate policy.
5. Mergecrew runs a **dry-run smoke test** — kicks off the dev deploy with a no-op commit, watches the workflow, confirms the URL is reachable. This proves the round-trip.
6. Theo schedules the first daily run for tomorrow at 08:00 in his timezone, or hits "Run now."

**Time budget for J1:** 10 minutes for a clean repo.

## J2 — Daily run, hands-off (Theo, every weekday)

1. 08:00. The Daily Run starts. Mergecrew enqueues a `DailyRun` for the project; the orchestrator activates the lifecycle.
2. **Discovery agent** reads inputs: yesterday's deferred changesets, open issues in the connected tracker, recent customer feedback (if Slack/Intercom integrations are connected), and the user's `intent inbox`.
3. **PM agent** translates discovery output into a prioritized list of intents, each with a one-paragraph spec.
4. For each intent, the **lifecycle fan-out** begins. In parallel-but-bounded:
   - **UX Designer agent** drafts the screen-level changes (text in V1; image generation in V2).
   - **Frontend / Backend Engineer agents** implement the change in a feature branch.
   - **QA agent** runs unit and integration tests, checks types, runs lint, optionally hits the dev URL with a smoke test.
5. **Deploy agent** triggers the dev pipeline. Pulls the dev URL out of the workflow output. Posts it as a PR comment.
6. **Bug Triage agent** continuously scans the dev URL and the project's error tracking integration; if an issue is detected mid-run, it files a follow-up changeset.
7. Throughout the day, the user sees a live timeline. They can intervene at any time, but they don't have to.
8. 17:00 (or user's "wrap-up" time). The **Digest agent** assembles the day's changesets into a single review surface and notifies Theo.

## J3 — End-of-day review and promote (Theo)

1. 17:30. Theo gets a Slack DM and email: "3 changesets ready, 1 needs your input."
2. He opens the **Digest** on mobile.
3. For each changeset he sees:
   - One-paragraph "what & why" in plain language.
   - Screenshots: before / after.
   - The dev URL link.
   - Diff summary (file count, additions, deletions, risk flags if any).
   - Test results.
   - Estimated cost (tokens × $).
   - Actions: **Promote** / **Rollback** / **Defer** / **Open transcript**.
4. Theo promotes two, rolls back one. The promoted set is grouped into one production deploy that fires immediately.
5. The rolled-back changeset's PR is reverted on dev; the failure reason ("user disliked the empty-state copy") feeds back into Discovery for tomorrow.

## J4 — Provider rate-limit pause and resume (system, transparent)

1. Mid-afternoon, Anthropic returns a 429 with `Retry-After: 1800` for the engineering agent's primary model.
2. The orchestrator marks the run `paused-rate-limit`, persists the checkpoint, schedules a wake-up at `now + 1800s + jitter`.
3. The timeline shows a "rate-limited, resuming at 16:42" marker. Other agents using a different provider continue.
4. (If a fallback provider is configured for this skill: the orchestrator immediately fails over, no pause.)
5. At 16:42, the run resumes from the last completed step.
6. Theo doesn't notice unless he looks at the timeline.

## J5 — Hard stop on a sensitive area (Mira)

1. Engineer agent attempts to modify `apps/api/src/auth/sessions.service.ts`.
2. The path matches a "don't touch without approval" pattern in the project policy.
3. The agent's tool call is **intercepted**: the change is captured but not committed; an approval task is created instead.
4. The run continues on other branches; this changeset is parked at "awaiting human."
5. Mira gets the notification, opens the proposed diff in the inbox, approves with optional comments. Mergecrew resumes the changeset from the approved diff.

## J6 — Manual intent injection (Theo, ad-hoc)

1. Theo, mid-morning, types into the project's **intent inbox**: "The customer onboarding email mentions a feature we removed. Find it and update the copy."
2. The intent is queued. PM agent picks it up at the next planning tick, scopes it as a single changeset, and routes it.
3. By the time Theo refreshes, the change is in flight.

## J7 — Bug detected, auto-fix (system + Theo)

1. A previously-promoted feature triggers a Sentry error in production. (Sentry integration is configured.)
2. Bug Triage agent ingests the error, correlates it to a recent changeset, attempts a fix on a new feature branch.
3. The fix flows through QA → dev deploy.
4. It appears in the next digest with the label "Bugfix — addresses Sentry issue #4421" and a link.

## J8 — Configuration: changing a single agent's model (Mira)

1. Mira opens the project's **Agents** panel.
2. She finds "Frontend Engineer" agent → "Default model" → switches from Claude Sonnet to GPT-5 Codex.
3. The change is versioned in `mergecrew.yaml`. Tomorrow's run uses the new config; today's in-flight run continues with the old config (no mid-run config swap).

## J9 — Adding a custom skill (Mira)

1. Mira's project needs a skill: "Query our internal feature flag service to list active flags."
2. She defines the skill in `mergecrew.yaml` (name, description, OpenAPI/JSON-schema spec, auth ref).
3. She attaches it to the QA agent.
4. From the next run onward, that agent has access to the skill.

## J10 — Tenant offboarding

1. An owner deletes the project (or the org).
2. Mergecrew stops scheduling runs.
3. After a 30-day soft-delete window, all tenant data, transcripts, and embeddings are purged. The audit log is retained per the org's compliance setting.
4. The GitHub App can be uninstalled by the user from GitHub at any time, which immediately suspends scheduled runs for that repo.
