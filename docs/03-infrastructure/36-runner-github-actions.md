# Runner profile: `github_actions` (BYO GitHub Actions)

The `github_actions` profile runs your org's steps inside a **GitHub Actions workflow** in a repo you own. The deployment never runs your code on its own machines, never holds long-lived cloud credentials, and you pay nothing for compute beyond your existing GitHub Actions minutes.

Decision rationale: [ADR-0009](../adrs/0009-byo-agent-as-remote-sandbox-driver.md). Auth: [ADR-0007](../adrs/0007-byo-cloud-credentials.md).

## Status

Working end-to-end as of V2.ag (#772). Same architecture as the `agent` and `fargate_byo` profiles — the agent is the remote `SandboxDriver` for the step (see [`34-runner-agent.md`](34-runner-agent.md) for the protocol). The only difference is *how the agent gets started*:

- `agent`         — you run `docker run mergecrew/runner-agent` yourself.
- `fargate_byo`   — the deployment launches an ECS task in your AWS account.
- `github_actions`— the deployment calls `workflow_dispatch` on your repo; GitHub launches the agent inside a GHA runner.

## What happens on dispatch

1. The orchestrator routes the step to the supervisor's queue with a `github-actions` executor marker, and LPUSHes a claim onto the org's agent queue.
2. The supervisor mints a fresh per-step `mca_<orgSlug>_…` agent token (token is stored only as sha256 hash; see [ADR-0004](../adrs/0004-runner-agent-token-storage.md)).
3. The supervisor decrypts the user-supplied GitHub PAT and POSTs to `/repos/{owner}/{repo}/actions/workflows/{file}/dispatches` with three inputs:
   - `mergecrewStepId`
   - `mergecrewAgentToken`
   - `mergecrewApiUrl`
4. The workflow runs `mergecrew/runner-agent --token "$INPUT_MERGECREW_AGENT_TOKEN" --api-url "$INPUT_MERGECREW_API_URL" ...`.
5. The agent inside the GHA runner `/poll`s the claim, switches to sandbox-ops mode, and serves shell ops back to the supervisor.
6. When `runStep` finishes, the supervisor pushes a `step-done` sentinel; the agent exits, the workflow run completes.

## Configuration

Org admin → **Settings → Runner → GitHub Actions**:

| Field                       | Purpose                                                          |
| --------------------------- | ---------------------------------------------------------------- |
| Repo (`owner/repo`)         | The repo that hosts your runner workflow file.                   |
| Workflow file               | Filename inside `.github/workflows/`, e.g. `mergecrew-runner.yml`. |
| GitHub PAT                  | Personal access token with `repo` + `workflow` scopes. Envelope-encrypted via KMS_MASTER_KEY before persistence. Plaintext is never echoed back. |

On save the API performs `GET /repos/{owner}/{repo}` with the PAT to verify scope + accessibility; the save fails fast with a clear error if the token is missing scopes.

## Example workflow file

Drop this in `.github/workflows/mergecrew-runner.yml` in your repo:

```yaml
name: Mergecrew runner

on:
  workflow_dispatch:
    inputs:
      mergecrewStepId:
        description: The step id (from mergecrew).
        required: true
        type: string
      mergecrewAgentToken:
        description: One-shot agent bearer token.
        required: true
        type: string
      mergecrewApiUrl:
        description: Mergecrew deployment API URL.
        required: true
        type: string

jobs:
  run:
    runs-on: ubuntu-latest
    timeout-minutes: 30   # tune for your step durations
    steps:
      - name: Run mergecrew/runner-agent
        env:
          MERGECREW_AGENT_TOKEN: ${{ inputs.mergecrewAgentToken }}
          MERGECREW_API_URL: ${{ inputs.mergecrewApiUrl }}
          MERGECREW_AGENT_NAME: gha-${{ inputs.mergecrewStepId }}
          MERGECREW_AGENT_DRIVER: process
        run: |
          docker run --rm \
            -e MERGECREW_AGENT_TOKEN \
            -e MERGECREW_API_URL \
            -e MERGECREW_AGENT_NAME \
            -e MERGECREW_AGENT_DRIVER \
            ghcr.io/mergecrew/runner-agent:latest
```

Notes:
- `runs-on: ubuntu-latest` is the default GitHub-hosted runner. Use your own self-hosted runner label if you want the agent on your hardware.
- `timeout-minutes` is your safety net — set it slightly above your slowest step. The agent will exit cleanly on `step-done` long before this in normal operation.
- `MERGECREW_AGENT_DRIVER=process` is recommended; the GHA runner already provides isolation, and the docker driver inside docker would need DinD setup.

## Trust posture

| Surface                                | Lifetime / blast radius                                          |
| -------------------------------------- | ---------------------------------------------------------------- |
| GitHub PAT (envelope-encrypted on the deployment) | Whatever scopes you granted, until you rotate. Stored only as `runner_profiles.github_token_ciphertext` — same chokepoint as project secrets, Slack webhooks, etc. |
| Agent token (mca_<orgSlug>_…) in workflow inputs | Per-step ephemeral. The token is only usable while the agent is alive (seconds → minutes); after the step's outcome posts, the token is effectively spent against an absent peer. |
| GitHub Actions run logs                | Inputs to `workflow_dispatch` ARE visible in the Actions UI to users with read access to the repo. The agent token leaks if the workflow logs are public. **Mitigation**: keep the repo private; rotate the PAT if compromised. A future PR can route the token through a repo Secret rotated per-dispatch via the Secrets API. |

## Cost

GitHub-hosted runners are billed against your repo's account. Free for public repos; included minutes on private repos. Self-hosted runners are free of GitHub charges but you provide the compute.

## Troubleshooting

| Symptom                                                            | Likely cause                                                                              |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| "Save failed: github_actions: PAT rejected by GitHub (401)"        | Token expired or missing scopes. Regenerate with `repo` + `workflow`.                     |
| "Save failed: repo not found or PAT lacks access"                  | Org/repo typo, or the PAT belongs to a user without access to that repo.                  |
| `workflow_dispatch returned 422` in the supervisor logs            | The workflow file doesn't declare the three `workflow_dispatch` inputs above.             |
| Workflow runs but the step never starts on the deployment timeline | The agent container couldn't pull `ghcr.io/mergecrew/runner-agent:latest`. Check the workflow's logs. |
| Agent shows online then immediately offline                        | The agent received the step but the `runStep` on the supervisor errored. Check the run timeline for an `AGENT_STEP_FAILED`. |

## Related

- [ADR-0007](../adrs/0007-byo-cloud-credentials.md) — credential storage strategy (envelope-encryption for PATs).
- [ADR-0009](../adrs/0009-byo-agent-as-remote-sandbox-driver.md) — Architecture A; agent is the sandbox driver.
- [`34-runner-agent.md`](34-runner-agent.md) — the runner-agent docs (shared with the `agent` profile).
- [`35-runner-fargate-byo.md`](35-runner-fargate-byo.md) — the sibling AWS Fargate path.
