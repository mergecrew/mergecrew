# ADR-0001: Adopt ADR format under `docs/adrs/`

**Status:** Accepted — 2026-05-23.

## Context

The codebase already has long-form design docs under `docs/02-architecture/` (e.g. `13-runner-isolation.md`, `14-runner-microvm-decision.md`) that mix two distinct things: how a subsystem works today, and the reasoning behind the shape we landed on. The second part — the why — is what new contributors and future-us actually need when revisiting a choice, but it's buried inside multi-page exploratory writeups that are hard to scan and harder to keep current.

The V2.af "Tenant-owned runners (BYO)" milestone has a cluster of decisions whose rationale must outlive the PRs that implement them: transport choice (long-poll vs WebSocket), queue topology, default-deny on missing profile, cloud-credential storage strategy, and several more. Capturing them inline in design docs would double the docs' length; capturing them in PR descriptions makes them un-searchable after merge.

## Decision

We will keep an ADR log under `docs/adrs/` using Michael Nygard's format. Each decision lives in its own file `NNNN-short-slug.md` with sections Status / Context / Decision / Consequences / Alternatives. `docs/adrs/README.md` indexes all ADRs with their status.

ADRs are immutable once accepted. To change a decision we add a new ADR and mark the old one `Superseded by ADR-XXXX`. Design docs under `docs/02-architecture/` continue to describe current behavior; they link out to ADRs for the rationale.

## Consequences

- Decisions become findable in O(grep) instead of O(read every design doc).
- New ADRs are cheap to write (one page), so contributors will actually write them.
- Mild ongoing cost: keeping the index up to date. Mitigated by the index being part of the ADR PR template.
- A historical sediment of "why we chose this" will accumulate that survives team turnover.

## Alternatives considered

- **Inline rationale in design docs.** Rejected: the doc that describes how the runner works today is already long, and mixing "this is the code path" with "we picked it over X because Y" makes both harder to read.
- **PR descriptions as the canonical record.** Rejected: post-merge they're discoverable only via `git log -S` archaeology, and they age out of the contributor's mental model fast.
- **Notion / wiki / external decision log.** Rejected: this repo is OSS and aims for low contributor ramp-up; decisions must live next to the code, in git, reviewable by PR.

## Realized in

- #760 (bootstrap `docs/adrs/` + ADR-0001..0008).
