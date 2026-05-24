# Architecture Decision Records

This directory captures load-bearing architecture decisions in [Michael Nygard's ADR format](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions). Each ADR is a single markdown file with five sections — Status, Context, Decision, Consequences, Alternatives — and once accepted is treated as immutable. To change a decision, supersede the ADR with a new one and update the old one's `Status:` to point at the replacement.

## Why ADRs

Long-lived projects accumulate decisions that look arbitrary five minutes after a contributor joins ("why long-poll and not WebSockets?"). An ADR is the cheapest way to record _why_ — once, in one place, in a form that survives team turnover. Design docs under `docs/02-architecture/` describe how the system works _now_; ADRs describe _why we chose this shape over the alternatives_.

## Format

```
docs/adrs/NNNN-short-slug.md
```

Front-matter:

- **Title** as `# ADR-NNNN: <decision>`.
- **Status:** one of `Proposed`, `Accepted`, `Superseded by ADR-XXXX`, `Deprecated`.
- **Context:** the forces in play. Cite source files when relevant.
- **Decision:** the choice made, in present tense ("We will…").
- **Consequences:** good and bad effects. Be honest.
- **Alternatives considered:** what was rejected and why.

Keep each ADR short — one page is the goal, two is the limit. If you need more, you probably need a design doc under `docs/02-architecture/` and an ADR that points at it.

## Index

| #     | Title                                                                            | Status   |
| ----- | -------------------------------------------------------------------------------- | -------- |
| 0001  | [Adopt ADR format under `docs/adrs/`](0001-adopt-adr-format.md)                  | Accepted |
| 0002  | [Per-org `runner_profile` replaces global `RUNNER_SANDBOX`](0002-per-org-runner-profile.md) | Accepted |
| 0003  | [Pull-based long-poll transport for runner-agent](0003-runner-agent-long-poll.md) | Accepted |
| 0004  | [Enrollment token format and storage for runner-agent](0004-runner-agent-token-storage.md) | Accepted |
| 0005  | [Per-run driver dispatch via profile-specific BullMQ queues](0005-per-profile-queues.md) | Accepted |
| 0006  | [Trusted-org gating for the instance-builtin profile](0006-trusted-org-gating.md) | Accepted |
| 0007  | [AWS auth via STS role assumption; envelope-encrypt PATs](0007-byo-cloud-credentials.md) | Accepted |
| 0008  | [Default runner profile is `none`; runs blocked at scheduling](0008-default-profile-none.md) | Accepted |
| 0009  | [BYO runner agent as a remote `SandboxDriver`](0009-byo-agent-as-remote-sandbox-driver.md) | Accepted |
