# Personas

Mergecrew optimizes for two primary personas in V1. The roadmap (`docs/04-roadmap.md`) sequences additional personas later.

## Primary: Solo founder / technical CEO ("Theo")

**Profile.** Senior engineer, 8–15 years experience. Owns a SaaS that has between 10 and 1,000 paying customers. Codebase in TypeScript (NestJS / Next.js / Prisma). Deploys via GitHub Actions to AWS. Linear or GitHub Issues for tracking. Has a Cursor / Claude Code license already.

**Day in the life today.** Mornings: triage support tickets, write specs by hand, kick off Cursor session, write code, push, manually verify dev deploy, repeat. Afternoons: customer calls, billing, hiring conversations. Evenings: more code. Constant feeling: "I'm doing translation work that a model could do."

**What Theo wants from Mergecrew.**
- A reliable second brain that runs while he sleeps.
- *Real* PRs in his real repo — not toy code in a sandbox.
- Not having to babysit. He'll review at end of day, not throughout.
- Confidence that nothing will reach prod without him approving it.
- Confidence that nothing dumb (rm -rf, wide-scope refactor of payments code) will happen.

**What Theo doesn't want.**
- A new IDE.
- A new chat interface he has to talk to all day.
- Walled-garden code generation that doesn't end up in his real repo.
- Having to migrate his stack to use Mergecrew.

**Concrete success for Theo.**
- He wakes up, opens the digest on his phone, sees three changesets shipped to dev. Two are obvious wins, he taps Promote. One is a UI tweak he disagrees with, he taps Rollback. He's done in five minutes. The next day's queue is already populated based on what he promoted.

## Primary: Indie team CTO / staff eng running a small squad ("Mira")

**Profile.** CTO of a 5–15 person team. Has 1–3 engineers, 0–1 designer, 0–1 PM. SaaS in TypeScript. Existing engineering ritual (standup, sprint, code review). Skeptical of agents because they've seen Cursor produce convincing-but-wrong code.

**What Mira wants from Mergecrew.**
- A way to multiply her team's output without the team becoming code reviewers for an LLM full-time.
- Visibility into what agents are doing, not a black box.
- The ability to lock down sensitive areas (auth, billing, infra) so agents don't touch them autonomously.
- Per-agent / per-skill model choice — they care about cost and want to route cheap models to cheap tasks.
- Audit trails for compliance.

**What Mira doesn't want.**
- A 10x bill from an agentic platform that burned through tokens.
- A workflow that her team can't observe or override.
- Code in their repo whose provenance is unclear.

**Concrete success for Mira.**
- Her team uses Mergecrew for a defined slice of work (bug fixes, doc updates, dependency bumps, content/copy changes, small UI features), with hard gates on auth and payments. Mergecrew ships ~5 changesets a day on this slice. Her engineers spend their time on the harder 20%.

## Secondary (V1.x): Operator / non-engineering team member ("Riley")

**Profile.** PM, designer, support lead, or marketer at the same company as Theo or Mira.

**What Riley needs.**
- The ability to file an intent ("the empty state on the projects list looks sad — make it clearer that the user should connect a repo") and have it land as a real changeset.
- A simple UI for approving/rejecting digest items without reading code.
- Side-by-side preview of "before vs. after" with screenshots.

Riley does not need to read transcripts or change agent configs.

## Out-of-persona for V1

- Enterprise platform engineering teams. They will want SOC 2, SAML/SCIM, customer-managed keys, on-prem runners — all V3+.
- Non-TypeScript stacks. V1 is opinionated for NestJS/Next.js/Prisma. V2 broadens.
- "Vibe coders" with no existing repo. Mergecrew can scaffold for them, but they're not the primary target — the dogfood case is the existing-codebase case.

## Implications of these personas for the product

- **Approval UX must be phone-shaped.** Theo will review on his phone, on the bus. The digest is mobile-first.
- **The audit log must be cheap to read.** Mira won't trust what she can't audit, and won't read what's annoying to read.
- **Every action must have a human-readable "why".** "Engineer agent updated `apps/api/src/billing/...` because PM agent's spec required adding `tax_id` to invoices." If we can't say why, we shouldn't have done it.
- **"Don't touch" zones must be a first-class concept.** Path patterns + heuristic flags (auth, billing, secrets, migrations) that escalate the human gate automatically.
