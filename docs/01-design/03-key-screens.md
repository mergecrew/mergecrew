# Key screens

ASCII wireframes of the canonical screens. Each one is annotated with its purpose, primary persona, and key interactions.

> ASCII wireframes describe target UX; current implementation under `apps/web/src/app/` is more list-driven and minimal. Screens flagged below as "not yet implemented" exist only as design intent.

## S1 — Today (org landing)

**Purpose.** Glanceable answer to "what's happening across all my projects."
**Persona.** All. **Density.** Mobile-friendly.

```
┌──────────────────────────────────────────────────────────────┐
│  Mergecrew › Acme                                       Avatar ▾ │
├──────────────────────────────────────────────────────────────┤
│  Today, Fri May 8                                            │
│                                                              │
│  ▸ 2 changesets need your review     [Open inbox]            │
│  ▸ 3 runs in progress                                        │
│                                                              │
│  ─── Projects ───────────────────────────────────────────    │
│                                                              │
│  ●  acme-web                       Run in progress · 3 cs    │
│      Backend Engineer is opening PR #418 …                   │
│      [View timeline]                                         │
│                                                              │
│  ●  acme-internal                  Digest ready · 4 cs       │
│      2 promoted, 1 rolled back, 1 deferred                   │
│      [Open digest]                                           │
│                                                              │
│  ○  acme-marketing                 No run today              │
│      Next run: tomorrow 08:00 BRT       [Run now]            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

## S2 — Daily digest (the most important screen)

**Purpose.** Decide what ships. **Persona.** Theo (mobile), Mira (desktop).
**Status.** Not yet implemented — described as target UX.

```
┌──────────────────────────────────────────────────────────────┐
│  ← acme-web › Digest · Fri May 8                             │
│                                                              │
│  Today's work, ready to review.                              │
│  3 changesets · est. cost $4.21                              │
│                                                              │
│  ──────────────────────────────────────────────────────      │
│                                                              │
│  cs_2tA9X    Add tax_id field to invoice export              │
│  ───────────────────────────────────────────                 │
│  Why  Customer Acme reported tax_id missing from PDF; PM     │
│       agent picked this up from Linear ENG-412.              │
│                                                              │
│   ┌──── before ────┐    ┌──── after ────┐                    │
│   │  [screenshot]  │    │  [screenshot] │                    │
│   └────────────────┘    └───────────────┘                    │
│                                                              │
│  Diff   3 files · +47 / -8       Tests   ✓ 142 / 142         │
│  Risk   low (read-only render path)   Cost   $1.10           │
│  Dev URL  https://acme-web-pr418.dev.acme.io                 │
│                                                              │
│  [ Promote ]   [ Rollback ]   [ Defer ]   [ Open transcript ]│
│                                                              │
│  ──────────────────────────────────────────────────────      │
│                                                              │
│  cs_8nQ4Z    Tighten empty state copy on /projects           │
│  cs_5kE2P    Bump @prisma/client patch (5.18.1 → 5.18.2)     │
│                                                              │
│  ──────────────────────────────────────────────────────      │
│                                                              │
│  [ Promote 3 selected as one prod deploy ]                   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

Notes:
- The "Why" line is the one-paragraph explanation written by the PM/Doc-Writer agents — not a commit message.
- "Risk" is a heuristic chip computed from path patterns + file counts (`low | medium | high`).
- "Cost" is real, in USD, derived from tokens × provider price.
- The footer batch-promote button compiles selected changesets into a single prod deploy.

## S3 — Live timeline

**Purpose.** "What is the agent doing right now?" **Persona.** All.

```
┌──────────────────────────────────────────────────────────────┐
│  ← acme-web › Timeline · Fri May 8 · LIVE                    │
│                                                              │
│  08:00  ─●  Daily run started                                │
│  08:00     Lifecycle: Default V3                             │
│  08:01  ─●  Discovery agent  ✓ done · 12s · $0.04            │
│              Read 14 issues · 3 customer messages            │
│  08:01  ─●  PM agent         ✓ done · 41s · $0.18            │
│              Drafted 3 specs                                 │
│                                                              │
│  ▶ Spec: tax_id on invoice export                            │
│    08:02 ─●  Backend Eng     ✓ done · 1m 14s · $0.32         │
│    08:03 ─●  Frontend Eng    ✓ done · 22s · $0.06            │
│    08:03 ─●  QA              ✓ done · tests pass             │
│    08:04 ─●  Deploy (dev)    ✓ done · PR #418                │
│                  https://acme-web-pr418.dev.acme.io          │
│                                                              │
│  ▶ Spec: empty-state copy on /projects                       │
│    08:05 ─●  Frontend Eng    ⏳ in progress                  │
│              writing apps/web/app/projects/empty-state.tsx   │
│                                                              │
│  ▶ Spec: bump @prisma/client                                 │
│    08:05 ─◌  queued                                          │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

- Timeline events stream over SSE; the spinner under "in progress" updates from the active agent step.
- Each agent row is collapsible; expanding shows the latest tool call (e.g., "writing file X" → "running tests").
- A small "Open transcript" link at the right of each row leads to the full prompt+response replay.

## S4 — Changeset detail / transcript

**Purpose.** Audit and debug what an agent did. **Persona.** Mira.

```
┌──────────────────────────────────────────────────────────────┐
│  cs_2tA9X · Add tax_id to invoice export                     │
├──────────────────────────────────────────────────────────────┤
│  Status   Awaiting decision   Cost   $1.10  Tokens   42.3k   │
│  PR       acme-web#418        Dev    https://...             │
│  Branch   mergecrew/cs_2tA9X    Tests  ✓ 142 / 142             │
│                                                              │
│  ─── Story ─────────────────────────────────────────         │
│  Discovery picked up Linear ENG-412 (status: triaged).       │
│  PM scoped a single-PR change adding tax_id to:              │
│    • invoice DTO                                             │
│    • PDF render template                                     │
│    • API contract test                                       │
│                                                              │
│  ─── Diff ──────────────────────────────────────────         │
│   apps/api/src/billing/invoice.dto.ts        + 4 / - 1       │
│   apps/api/src/billing/pdf-renderer.ts       +14 / - 0       │
│   apps/api/test/billing/invoice.e2e-spec.ts  +29 / - 7       │
│   [ View full diff ]                                         │
│                                                              │
│  ─── Transcript (per agent) ────────────────────────         │
│   ▸ Discovery        12s    1.4k tokens                      │
│   ▸ PM               41s    9.8k tokens                      │
│   ▾ Backend Eng     1m14s  21.0k tokens                      │
│       step 1  read invoice.dto.ts                            │
│       step 2  draft change                                   │
│       step 3  write invoice.dto.ts                           │
│       step 4  run typecheck (✓)                              │
│       step 5  run unit tests (✓)                             │
│       [ Replay full prompt+response ]                        │
│   ▸ QA               18s    3.2k tokens                      │
│   ▸ Deploy (dev)     1m02s  0.9k tokens                      │
│                                                              │
│  [ Promote ]   [ Rollback ]   [ Defer ]                      │
└──────────────────────────────────────────────────────────────┘
```

## S5 — Approval inbox

**Purpose.** The user's queue of "things that need a human." **Persona.** All.
**Status.** Not yet implemented in this form — described as target UX.

```
┌──────────────────────────────────────────────────────────────┐
│  Inbox · 2 pending                                           │
├──────────────────────────────────────────────────────────────┤
│  acme-web · cs_3hN1L    auth/sessions.service.ts touched     │
│      Sensitive area · auto-escalated · waiting 1h 12m        │
│      [ Review ]                                              │
│                                                              │
│  acme-internal · cs_9pV3M  prisma/migrations/ touched        │
│      Schema migration · waiting 22m                          │
│      [ Review ]                                              │
└──────────────────────────────────────────────────────────────┘
```

A "Review" tap opens an approval-shaped variant of S4: the diff, the agent's reasoning, the proposed plan, and three buttons: **Approve & continue**, **Reject (with comment)**, **Take over** (Mergecrew stops, user takes the branch).

## S6 — Lifecycle viewer

**Purpose.** See the workflow graph for a project. **Persona.** Mira (desktop).

```
┌──────────────────────────────────────────────────────────────┐
│  acme-web · Lifecycle (mergecrew.yaml @ main)            [Edit ↗]│
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌─────────┐    ┌─────┐    ┌────────┐    ┌────────────────┐  │
│  │Discovery│───▶│ PM  │───▶│ Design │───▶│ Implementation │  │
│  └─────────┘    └─────┘    └────────┘    └────────────────┘  │
│                                                       │      │
│       ┌────────┐    ┌────────────┐    ┌─────────┐     ▼      │
│       │ Triage │◀── │ Observation│◀───│ Deploy  │◀──── QA    │
│       └────────┘    └────────────┘    └─────────┘            │
│         (loop)                            ▲                  │
│                                           │                  │
│                                  ┌────────┴────────┐         │
│                                  │ Production gate │         │
│                                  │  ★ requires user│         │
│                                  └─────────────────┘         │
└──────────────────────────────────────────────────────────────┘
```

- Hover a node → side panel listing the agents at that node, their model, their skills.
- ★ = hard gate, cannot be relaxed.
- Edit ↗ opens the underlying `mergecrew.yaml` in GitHub for editing. An in-app visual editor with PR generation is Planned.

## S7 — Agent detail

**Purpose.** Inspect and configure one agent. **Persona.** Mira.
**Status.** Not yet implemented — described as target UX.

```
┌──────────────────────────────────────────────────────────────┐
│  Backend Engineer Agent                                      │
├──────────────────────────────────────────────────────────────┤
│  Model       claude-opus-4-7  (capability: reasoning+tools)  │
│              Fallback: bedrock anthropic.claude-opus-4-7     │
│              Fallback: openai gpt-5-codex                    │
│  Active in   Implementation                                  │
│  Skills      repo.read_file, repo.write_file,                │
│              build.run_typecheck, build.run_unit_tests, …    │
│  Don't-touch apps/api/src/auth/**                            │
│              apps/api/src/billing/payments/**                │
│  Recent      8 changesets last 7d · 75% promoted             │
│                                                              │
│  [ View 7-day transcript history ]                           │
└──────────────────────────────────────────────────────────────┘
```

## S8 — Onboarding checklist

**Purpose.** Get the user from "looking at the seeded demo" to "first run on their own repo." **Persona.** All.

The current implementation lives at `/orgs/{slug}/onboarding` and renders a **DB-derived checklist**, not a multi-step wizard. Each item resolves once the underlying record exists, so a user can complete steps in any order and refresh-resume without losing progress.

Sections, in checklist order:

1. **LLM provider** — register one provider/profile (Anthropic, OpenAI, Bedrock, Ollama). Inline form. Skippable while `MERGECREW_DEMO_MODE=1` is set.
2. **GitHub App** — install on the target org/repo. Status pulled from `Integration` rows.
3. **Project** — create a project pointed at the connected repo. The Lifecycle page lets the user pick a stock template (`roster` (default 9-agent graph), `generic-careful` (legacy 3-agent loop), `nextjs-vercel`, `python-render`, `go-fly`).
4. **Deploy target** — at minimum one `dev` target (configured under project settings → deploy targets).
5. **Schedule** — set the cron or leave it unscheduled and run on-demand.

> **Planned (not in S8 today):** automatic stack detection, env-var import from `.env.example`, end-to-end smoke-test that fires a no-op deploy. These are part of the future Project Inception flow (see `00-product/05-features.md`).

## Visual language

- Typography: system font stack + Inter for headings.
- Color: muted neutral palette; one accent (deep teal); status colors (green/amber/red) reserved for run state, never for UI chrome.
- Spacing: 4 / 8 / 16 / 24 / 32 / 48 px scale.
- Components: Tailwind + lucide-react; UI primitives in `apps/web/src/components/ui.tsx`. No custom design system.
- Iconography: Lucide.
- No anthropomorphic illustrations of agents (no robot avatars). Icons for agents are role-shaped (gear for engineer, magnifying glass for QA, etc.).
