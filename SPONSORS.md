# Sponsor Mergecrew

Mergecrew is open source under [Apache 2.0](LICENSE) and is built in the open. The project welcomes sponsors — individuals, companies, or model providers — who want to see it ship.

## Why sponsorship matters

Mergecrew runs autonomous LLM workflows daily against real codebases. Even modest dogfooding burns real money in API credits — running one end-to-end loop on a medium-sized repo costs anywhere from $0.50 to $5 in token spend depending on the model. Without sustained funding for credits, alpha-stage tuning, regression testing on new model releases, and capability-probe work on the Bedrock / Ollama provider catalogs are impossible.

We need help with three concrete things, listed by priority.

## 1. LLM API credits (most useful)

In rough order of impact:

| Provider | What it unlocks |
|---|---|
| **Anthropic** | Claude Sonnet / Opus / Haiku — the primary model family used in dogfooding |
| **OpenAI** | GPT-5 / o-series — keeps the OpenAI provider working as the abstraction iterates |
| **AWS Bedrock** | Anthropic-on-Bedrock fallover testing; capability inference for Titan / Cohere embeddings |
| **Cohere · Mistral · DeepSeek** | Non-Anthropic provider testing as the supported set expands |

Even **$50–$200 of credits goes a long way** at this stage. Mergecrew is multi-tenant by design, so a sponsor's credits underwrite testing of capabilities every contributor benefits from.

## 2. Compute and hosting

- A small VM or container hosting credit (DigitalOcean, Linode, Hetzner, Fly.io, AWS) to host a public dogfood deployment for demonstration and integration testing.
- GPU credits for testing local Ollama models that are too large for a laptop.
- Object storage credits (S3 / R2 / B2) for transcript blobs at scale.

## 3. People time

- Code review on PRs that touch the agent runtime, multi-tenancy, or the production-promote gate.
- Triage and labeling on incoming issues.
- Documentation contributions — especially for self-hosting and provider configuration.

See [CONTRIBUTING.md](CONTRIBUTING.md) for how to start.

## How to sponsor

| Channel | Best for |
|---|---|
| **GitHub Sponsors** | Recurring monetary backing — see the "Sponsor" button at the top of the [repo](https://github.com/mergecrew/mergecrew) once configured |
| **API credit transfers** | Open an [issue](https://github.com/mergecrew/mergecrew/issues/new?title=Sponsor%3A+%5Byour+org%5D) titled "Sponsor: \[your org]" or start a [Discussion](https://github.com/mergecrew/mergecrew/discussions). We'll reply privately to coordinate the credit transfer |
| **Cloud / hosting credits** | Same as above |
| **Code or review time** | Pick a `roadmap` issue from the [project board](https://github.com/orgs/mergecrew/projects/1) and open a PR |

## Current sponsors

> **Looking for the first.** No active sponsors yet — be the one whose name lands here.

Token credit sponsors are acknowledged in this file, in release notes, and (with permission) on the project README. Cash sponsors via GitHub Sponsors are listed automatically by the platform.

## What sponsors get

- Acknowledgment in this file, the project README, and release notes.
- Optional: a logo and link in this file.
- Visibility into the project's roadmap, with the ability to nominate (not dictate) priorities via [Discussions](https://github.com/mergecrew/mergecrew/discussions).
- For sustained sponsors: a private channel to surface bugs that affect their use case.

**Sponsorship buys runway, not steering.** The production-promote human gate, the multi-tenancy invariants, and the open-source license will not change in exchange for sponsorship. The maintainers reserve the right to decline a sponsorship that would create a conflict with the project's invariants.

## Transparency

We will publish a quarterly note to [Discussions](https://github.com/mergecrew/mergecrew/discussions) summarizing how sponsor credits were used (which models were exercised, which test runs they enabled, what was learned). At alpha stage we will publish more frequently if the volume warrants.

## Contact

Open a [Discussion](https://github.com/mergecrew/mergecrew/discussions/new?category=general) titled "Sponsorship", or open an [issue](https://github.com/mergecrew/mergecrew/issues/new). For private inquiries, message a maintainer directly on GitHub.
