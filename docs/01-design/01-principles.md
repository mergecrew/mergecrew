# Design principles

## 1. The product's center of gravity is the digest, not the dashboard.

Most of the user's interactions happen at end-of-day, on a phone, deciding what to ship. Every other surface in Mergecrew serves that moment. If a feature doesn't make the digest more decisive, it's a distraction.

## 2. Make the agent legible.

When an agent did something, the user should be able to answer "why" in under five seconds without reading code. Every changeset carries a one-paragraph human explanation written *for the user persona*, not the engineer. The transcript is *available* but never *required*.

## 3. Every action has an undo, every decision has a record.

There is no destructive action in the UI without a one-click reversal: rolled-back PRs can be re-promoted, deferred items can be promoted later, deleted projects soft-delete for 30 days. Every promote/rollback decision is timestamped and attributed.

## 4. Mobile-first for review, desktop-first for configuration.

The digest, the approval inbox, and the live timeline are designed for a phone screen first. Lifecycle editing, agent configuration, and transcript replay are desktop-first.

## 5. Calm, not exciting.

This product runs while the user sleeps; the UI's job is to convey "everything is under control." That means: muted colors, no unnecessary motion, no anthropomorphizing the agents (no chat bubbles with avatars saying "I think we should..."), no streaming text that makes the user feel they need to read live.

## 6. Show *what* and *what's next*, hide *how* by default.

The default view of an agent's work is "what it did + what it's about to do." The "how" — prompts, tool calls, model choice — is one click deeper. Power users open the transcript; everyone else doesn't.

## 7. Configuration lives in the repo.

`mergecrew.yaml` is the source of truth for project lifecycle, agents, skills, and gates. The web UI is a *view* of that file, with edit-and-commit semantics. This means every config change is in git history, reviewable like code, and revertable.

## 8. Defaults must do the right thing.

Every setting Mergecrew ships with should be the right answer for 80% of users. We earn the right to add a setting only when we can name the project that needs it.

## 9. Cost must be visible, not hidden.

Every changeset carries an estimated cost. The end-of-day digest carries a daily total. Per-project monthly cost is visible on the project page. Surprise bills break trust.

## 10. Treat the agent like an employee, not a tool.

That means: written job descriptions (agent definitions), defined responsibilities (skills), reviewable output (PRs in your repo), the ability to promote/demote (model assignment), and clear consequences for mistakes (rollback, transcript audit). It does not mean cute names, faces, or personalities.
