# Mergecrew dogfood target

The V0.5 exit criterion (#5) is:

> From a CLI, given the test repo, the agent edits a file, opens a PR,
> triggers the test repo's `deploy-dev.yml`, retrieves the dev URL.

This directory holds the **reference artifacts** the dogfood test repo needs
to participate. The actual repo (`mergecrew/dogfood-target` or similar) lives
on GitHub — Mergecrew can't create it from its own runtime because that
needs org-admin auth on the target org.

## Setting up a dogfood repo

1. **Create the repo** on the GitHub org you want to dogfood against. It
   can be empty or contain a tiny app — the smoke run only writes a marker
   file, so any repo will do.

2. **Install the Mergecrew GitHub App** on the repo:
   - For local Mergecrew dev: use a personal GitHub App registered against
     the test org. Grant it `Contents: Read & Write`, `Pull Requests: Read &
     Write`, `Actions: Read & Write`, `Metadata: Read`.
   - For the OSS Mergecrew App: install the public app onto the org and
     copy the resulting installation id.

3. **Drop `deploy-dev.yml`** into `.github/workflows/deploy-dev.yml`. Use
   `infra/dogfood/deploy-dev.yml` as the starting point — the only contract
   the smoke driver depends on is `workflow_dispatch` and a successful
   final exit. Replace the `Echo would-be deploy` step with whatever the
   repo actually deploys to.

4. **Run the smoke**:

   ```bash
   GITHUB_APP_ID=12345 \
   GITHUB_APP_PRIVATE_KEY="$(cat path/to/app-private-key.pem)" \
   INSTALLATION_ID=98765 \
   REPO_FULL_NAME=mergecrew/dogfood-target \
   URL_PATTERN='https://${branch}.preview.example.com' \
     pnpm --filter @mergecrew/dogfood-smoke smoke
   ```

   On success the script prints a one-line `[smoke] OK PR=… dev=…` line
   with the PR url and the resolved dev URL.

## What the smoke driver does

`apps/dogfood-smoke/src/main.ts` exercises both adapters end-to-end:

| step | adapter call                                        |
|------|-----------------------------------------------------|
| 1    | `GitHubProvider.cloneIntoWorkspace`                 |
| 2    | `GitHubProvider.createBranch`                       |
| 3    | `GitHubProvider.commit` + `GitHubProvider.push`     |
| 4    | `GitHubProvider.openPullRequest`                    |
| 5    | `GitHubActionsProvider.triggerDeploy`               |
| 6    | `GitHubActionsProvider.awaitCompletion`             |
| —    | `GitHubActionsProvider.resolveUrlForRef` (final)    |

It exits non-zero on any failure and prints a diagnostic. The PR is left
open in **draft** state so the dogfood-target maintainer can close it
without merging — the smoke is non-destructive.

## URL resolution modes

The deploy provider supports three URL-resolution strategies, switchable
via the `URL_RESOLUTION` env on the smoke driver:

- `pattern` (default) — interpolate `${branch}` / `${sha}` into
  `URL_PATTERN`. Most flexible for preview-per-branch hosting (Vercel,
  Netlify, Render branch deploys).
- `fixed` — always returns `URL_FIXED`. Useful when the dev environment is
  a single shared URL the workflow refreshes in place.
- `workflow_output` — read the URL from the workflow run's
  `$GITHUB_OUTPUT`. Requires the workflow to emit one (not yet wired in
  the GitHubActionsProvider; placeholder for V0.6).
