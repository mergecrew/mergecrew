# Vision

> Working codename: **Mergecrew**.

## One-line

Mergecrew is an autonomous product team in a box: it specifies, designs, builds, deploys, tests, and triages bugs on a SaaS codebase every day, and asks the human only at the moments where judgment is required.

## The problem

Building a SaaS product is bottlenecked by humans doing low-leverage loops:

- Writing tickets out of fuzzy intent.
- Translating tickets into specs.
- Translating specs into UI flows and component sketches.
- Translating designs into code.
- Reading the dev deploy and noticing what's broken.
- Filing bug tickets out of what was just observed.
- Repeating, daily, forever.

Each of these steps is a translation that an LLM is now good enough to do — but only if it lives inside a durable loop with memory, deployable side-effects, and the ability to ask a human at the right moments. Single-shot agents (a Cursor session, a Claude Code run, a v0 generation) hit a ceiling because nothing is connecting their output back into the loop the next morning.

## The shape of the product

A Mergecrew tenant has one or more **Projects**. A Project is bound to:

- A GitHub repository.
- A set of deploy targets (one is the user's existing dev environment; production is gated).
- A **Lifecycle** — a graph of **Workflows** (Discovery → Spec → Design → Implementation → QA → Deploy → Observation → Bug Triage).
- For each Workflow, a roster of **Agents** (Product Manager, UX Designer, Backend Engineer, Frontend Engineer, QA, SRE, etc.).
- For each Agent, a set of **Skills** (tool-shaped capabilities — read repo, run tests, deploy preview, query analytics, post Slack message, etc.).
- For each transition, a declaration of whether a **human gate** is required.

Every morning at the project's configured kickoff time, the Daily Run begins. Agents work the lifecycle. Each step emits **Timeline Events** the user can watch in real time. Throughout the day a stream of changesets land on dev. At end of day the user is shown a digest and decides per changeset: **promote**, **rollback**, or **defer**.

When the underlying LLM provider returns a rate limit or quota error, the loop sleeps until the window reopens, then resumes from the last durable checkpoint. The user is not in the loop for this — only for promotion decisions and the human gates they configured.

## What makes Mergecrew different

1. **It runs unsupervised for a full day.** Most agentic tools are session-shaped (you sit there). Mergecrew is loop-shaped (it works while you sleep).
2. **It is built around the *promotion* moment, not the *generation* moment.** Generation is cheap; deciding what to ship is the bottleneck. The end-of-day digest, diffs, deploy URLs, and one-click promote/rollback are first-class.
3. **It is model-agnostic and provider-agnostic by design.** Anthropic, OpenAI/Codex, Bedrock, and local Ollama models are all behind one interface. A skill says "I need a strong reasoning model with tool use" and the platform routes it.
4. **It works on real, existing SaaS projects.** The default code surface is the user's existing GitHub repo. The default dev deploy is the user's existing GitHub Actions pipeline.
5. **Human-in-the-loop is configurable, not bolted on.** Every workflow node can declare a gate; sane defaults ship out of the box and can be tightened or relaxed per project.

## Working principles

- **Durable by default.** Every agent step is a checkpoint. Crashes, restarts, and rate-limit pauses must not lose work.
- **Observable by default.** Every action, prompt, tool call, and model response is captured for replay and audit.
- **Reversible by default.** Nothing reaches production without an explicit human decision; everything that reaches dev can be reverted in one click.
- **Cheap to be wrong.** Bias toward small, frequent, revertible changesets over large monolithic PRs.
- **The user owns the code.** The repo is theirs, the GitHub history is real, the PRs are real. Mergecrew is not a walled garden.

## Non-goals (explicit)

- Mergecrew is not a replacement IDE. The user still has Cursor / VS Code / Claude Code for ad-hoc work.
- Mergecrew is not a deployment platform. It orchestrates existing pipelines; it does not replace Vercel, GitHub Actions, ECS, etc.
- Mergecrew does not auto-promote to production. Ever. Humans decide.
- Mergecrew is not trying to be the cheapest LLM router on the market. Provider abstraction exists for fit and resilience, not arbitrage.
