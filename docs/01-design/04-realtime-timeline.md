# Real-time timeline UX

The timeline is the surface that conveys "Mergecrew is working" without demanding attention. Designing it well is the difference between users feeling reassured and users feeling anxious.

## Goals

1. **Reassure, don't excite.** A user glancing at the timeline should feel "this is on track," not "I need to read this."
2. **Be useful asynchronously.** A user opening the timeline at 2pm for a run that started at 8am should understand the day in 10 seconds.
3. **Be useful in real time.** A user watching live should see meaningful progress, not raw token streams.
4. **Be replayable.** Yesterday's timeline must look exactly the same as today's live one (no information lost in archival).

## Event taxonomy

The timeline is a sequence of typed events. The full taxonomy is:

```
RUN_STARTED            run-level
RUN_PAUSED_RATE_LIMIT  run-level (with retry-at)
RUN_RESUMED            run-level
RUN_COMPLETED          run-level
RUN_FAILED             run-level

WORKFLOW_STARTED       workflow-level (e.g., Discovery, PM, Implementation)
WORKFLOW_COMPLETED     workflow-level

CHANGESET_OPENED       changeset-level (PR opened on dev)
CHANGESET_DEV_DEPLOYED changeset-level (dev URL ready)
CHANGESET_TESTS_PASSED changeset-level
CHANGESET_TESTS_FAILED changeset-level
CHANGESET_FLAGGED      changeset-level (sensitive area, awaiting human)
CHANGESET_PROMOTED     changeset-level
CHANGESET_ROLLED_BACK  changeset-level

AGENT_STEP_STARTED     agent-level
AGENT_STEP_COMPLETED   agent-level (cost, tokens)
AGENT_STEP_FAILED      agent-level
AGENT_TOOL_CALL        agent-level (skill name + brief args)
AGENT_DECISION         agent-level ("PM picked 3 of 12 candidate intents")

GATE_REACHED           gate-level (auto/notify/require-approval)
HUMAN_APPROVED         gate-level
HUMAN_REJECTED         gate-level
```

Every event carries: `id`, `org_id`, `project_id`, `run_id`, `timestamp`, `actor` (`agent_id` or `user_id`), `parent_id` (for nesting under workflow / changeset), `payload`. They're persisted; the SSE stream is just a view of the persisted log.

## Default rendering rules

- **Two-level nesting maximum** in the rendered tree: run → workflow → agent step. Anything deeper (tool call within step) is collapsed unless expanded.
- **Per-changeset cluster.** Once a changeset is opened, all subsequent events for that changeset are grouped inside its cluster. The cluster header is the changeset title; expanding it shows its agent steps.
- **In-progress is the spinner row, not a paragraph.** When an agent is mid-step, its row shows: `[spinner] BackendEng — running typecheck (4s)`. The verb comes from the latest `AGENT_TOOL_CALL` event.
- **No streamed tokens in the default view.** The transcript replay shows raw model output; the timeline does not. (Streaming raw tokens makes users feel they need to read.)
- **Costs render trailing.** Each completed step shows `· $0.18` at the right. Running totals at the run-header level.

## Time formatting

- "Time of day" (HH:MM) on the left rail for normal events.
- Relative time ("4s ago") on the spinner row for in-progress steps.
- A subtle dimming on events older than 1 hour, so the eye lands on recent activity.
- The header always shows the run's wall-clock duration in HH:MM.

## Density modes

**Comfortable** (default, mobile always):
```
08:01 ─● PM agent          ✓ done · 41s · $0.18
       Drafted 3 specs
```

**Compact** (desktop power-user):
```
08:01 ●  PM     ✓ 41s  $0.18  drafted 3 specs
```

The toggle is per user, persisted in their profile.

## Live vs replay

Live and replay use the same renderer. Differences:

- Live: SSE connection open, spinner active, "LIVE" pill in the header.
- Replay: events backfilled from DB, no SSE, no spinner, header shows the run's start–end times instead of "LIVE."
- Replay supports time-scrub: a slider at the top to jump to any wall-clock minute of the run.

## Pause states

When the run is paused (rate-limit), the header turns amber and shows:

```
⚠ Paused — provider rate limit
  Will resume at 16:42 (in 27m)        [ View affected provider ]
```

The body keeps rendering. Other agents on different providers continue executing; their rows continue to update. This makes it visible that Mergecrew is *not* idle, just one path is.

## Failure states

When a run fails (not paused, actually errored):

```
✗ Run failed at 11:14
  Reason: Backend Engineer step exceeded retry budget after tool error
          Skill: build.run_unit_tests
          Detail: process exited with code 1, see transcript

  [ Open transcript ]   [ Restart from this step ]   [ Abandon run ]
```

`Restart from this step` re-enqueues only that step using the same input checkpoint.

## Human-gate states

When a gate halts a workflow:

```
🛑 Awaiting your decision (1h 12m)
   Gate: auth-area-touched · severity: high
   [ Review changeset ]   [ Quiet me ]
```

`Quiet me` snoozes notifications for this gate (the gate itself doesn't move).

## Mobile-specific behaviors

- Timeline is a single column, no horizontal scrolling, no pinch-zoom.
- Tapping an agent row expands it to full-screen.
- The header shrinks to a single sticky row: `acme-web · LIVE · 2 cs ready`.
- Pull-to-refresh re-syncs from the server (in case SSE dropped).

## Accessibility

- Color is never the only signal. Spinner = motion + text label. ✓ / ✗ glyphs accompany green/red.
- All event rows are real DOM nodes with semantic roles, not canvas. Screen readers can read the day chronologically.
- Live region (`aria-live="polite"`) announces new run-level events only — *not* every agent tool call (that would be a flood).
- Reduced-motion preference disables the spinner animation in favor of a static dot that pulses opacity slowly.

## What we explicitly don't do

- No avatars or chat bubbles for agents.
- No "Mergecrew is thinking…" copy.
- No streaming of model output as the primary surface.
- No Discord/Slack-style "X is typing…" footer. (The spinner row is the equivalent and is on the agent's actual row.)
- No confetti on success.
