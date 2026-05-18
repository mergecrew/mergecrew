# VCS adapter

Mergecrew's relationship with the user's repository is mediated entirely through the `VcsProvider` interface. The current implementation is GitHub (`packages/adapters-vcs/src/github.ts`). GitLab/Gitea adapters are Planned. Mergecrew does not run its own forge.

## Interface

The interface lives in `packages/adapters-vcs/src/types.ts`:

```ts
interface VcsProvider {
  readonly id: 'github' | 'gitlab' | 'gitea';

  // Workspace
  cloneIntoWorkspace(repo: ConnectedRepoRef, ref: string, dest: string): Promise<void>;
  fetchUpdate(workspace: string, ref: string): Promise<void>;

  // Branches & commits
  createBranch(workspace: string, name: string, fromRef: string): Promise<void>;
  commit(
    workspace: string,
    opts: { message: string; authorName: string; authorEmail: string; signoff?: boolean },
  ): Promise<string>;                    // returns the commit sha
  push(workspace: string, branch: string): Promise<void>;

  // PRs
  openPullRequest(repo: ConnectedRepoRef, opts: PullRequestOpts): Promise<PullRequest>;
  commentOnPullRequest(repo: ConnectedRepoRef, prNumber: number, body: string): Promise<void>;
  postReview(repo: ConnectedRepoRef, prNumber: number, opts: PostReviewOpts): Promise<void>;
  markReadyForReview(repo: ConnectedRepoRef, prNumber: number): Promise<void>;
  mergePullRequest(repo: ConnectedRepoRef, prNumber: number, opts: MergeOpts): Promise<MergeResult>;
  revertPullRequest(repo: ConnectedRepoRef, prNumber: number): Promise<{ revertPrNumber: number }>;
  closePullRequest(repo: ConnectedRepoRef, prNumber: number): Promise<void>;

  // Read-only
  listOpenPullRequests(repo: ConnectedRepoRef): Promise<PullRequest[]>;
  getDefaultBranch(repo: ConnectedRepoRef): Promise<string>;
  getFileAt(repo: ConnectedRepoRef, ref: string, path: string): Promise<{ contentBase64: string }>;

  // Webhook ingestion
  verifyWebhookSignature(headers: Record<string, string>, body: Buffer, secret: string): Promise<boolean>;
  parseWebhookEvent(headers: Record<string, string>, body: Buffer): VcsEvent;
}
```

## GitHub implementation

### App, not OAuth

Mergecrew is installed as a **GitHub App**, not via personal OAuth. Reasons:

- Per-installation tokens with explicit repo and permission scopes.
- Tokens are short-lived and re-issued automatically.
- Webhook URL is per-app, not per-user.
- Does not depend on a specific human's GitHub account remaining at the company.

### Permissions requested

- **Repository**:
  - Contents: read & write (required for cloning, committing, branching).
  - Pull requests: read & write (open, comment, merge, revert).
  - Workflows: read & write (trigger workflow_dispatch for the deploy adapter).
  - Checks: read (read CI status).
  - Issues: read & write (Bug Triage agent comments and creates issues).
  - Metadata: read.
- **Account**:
  - Email addresses: read (used at sign-up if user authenticates with GitHub).

The principle is "as few as needed for V1." We do not ask for `Administration` or `Org members` permissions.

### Webhooks

Mergecrew subscribes to:

- `pull_request` (opened, synchronize, closed, reopened, edited, ready_for_review, review_requested).
- `pull_request_review` and `pull_request_review_comment` (so user comments on PRs feed back to agents).
- `workflow_run` (so the deploy adapter learns of completion).
- `installation` and `installation_repositories` (track app install/uninstall).
- `check_run` (CI status updates).

Webhooks are delivered to `/webhooks/github`, signature verified, persisted, then dispatched onto the orchestrator's inbox.

### Workspaces

Each Changeset gets a per-changeset working directory:

```
/var/mergecrew/work/{run_id}/{cs_id}/
```

Lifecycle:

1. **Setup.** `git clone --depth 50 --branch <default> --filter=blob:none <repo-url>`. Shallow + partial clones to keep IO low.
2. **Branch.** `git checkout -b mergecrew/<cs_id>`.
3. **Edits.** Skills (`repo.write_file`, etc.) operate on this tree.
4. **Commits.** Commits are authored as `Mergecrew (<agent-kind>) <mergecrew@<tenant>.mergecrew.dev>`, with a `Co-authored-by:` trailer for the underlying provider+model when relevant.
5. **Push.** `git push origin mergecrew/<cs_id>`.
6. **PR.** `openPullRequest` against the project's configured base branch.
7. **Teardown.** Workspace is destroyed when the changeset reaches a terminal state.

Branch naming: `mergecrew/<cs_id>` (cs_id is the short URL-safe Changeset id). Long-running changesets get a human-readable suffix: `mergecrew/<cs_id>-tax-id-export`.

### Commit messages

The intended commit-message convention (Planned — not yet stamped by the adapter; `commit()` currently passes the agent-authored message through unchanged):

```
<type>(<scope>): <subject>

<body>

Mergecrew-Changeset: cs_2tA9X
Mergecrew-Run: run_2026-05-08_p1
Mergecrew-Lifecycle-Node: implementation
Co-authored-by: <agent-kind> via <provider>/<model>
```

`<type>` follows Conventional Commits. The body is written by the agent; the trailers will be stamped by the runtime once trailer support is implemented.

### PR body

PRs include:

- A "What & why" paragraph (PM agent's spec, condensed).
- A "How" section (high-level summary of changes).
- A "Test plan" checklist.
- A "Risk" callout (sensitive paths, irreversible operations, schema changes).
- A "Mergecrew metadata" footer (run id, changeset id, links to the timeline and transcript).

### Draft PR + reviewer verdict surfacing

`openPullRequest` opens the changeset's PR as a **draft**. The reviewer agent's verdict is then surfaced natively in the host's review UI rather than only in Mergecrew:

1. The runner calls `postReview(repo, prNumber, { event, body, comments? })` with the reviewer's verdict — `'approve'`, `'request_changes'`, or `'comment'`. On GitHub this becomes a real review entry visible in the PR's Reviews tab; inline comments map to per-line review comments.
2. If the verdict is `'approve'`, the runner then calls `markReadyForReview(repo, prNumber)` to flip the draft PR to ready-for-review. A human reviewer arrives on a PR that already has an LLM review attached and only sees diffs the LLM was confident about.
3. Both calls are **best-effort** — the runner logs and continues on failure rather than blocking the changeset. Adapters that don't yet support draft-PR review (`gitea`, `gitlab` today) implement the methods as warning-and-resolve no-ops.

Call sites: `apps/runner/src/step.ts` (look for `postReview`); shapes in `packages/adapters-vcs/src/types.ts` (`PostReviewOpts`, `InlineReviewComment`).

### Authorship and attribution

Commits are authored by a Mergecrew bot identity tied to the tenant, not by the human user. This:
- Keeps blame readable.
- Lets the user's commit verification policies treat Mergecrew commits explicitly.
- Avoids confusing "did I write this?" moments during code review.

### Don't-touch enforcement

Before any `repo.write_file` or `repo.git.commit`, the policy engine compares written paths against:
- Agent's `do_not_touch` patterns (per-agent).
- Project's sensitive patterns (per-project, e.g., `apps/*/src/auth/**`).
- Lifecycle's hard-blocked patterns (project-wide, e.g., `**/.env*`).

Hits on agent-level patterns auto-escalate to a human gate. Hits on project-level patterns require approval before continuing. Hits on hard-blocked patterns reject the tool call outright.

### Rate limits & backoff

GitHub API rate limits are real:
- Per-installation: 5,000 req/h baseline.
- Mergecrew tracks rate-limit headers and backs off proactively.
- Workspace operations prefer the Git protocol over the API for bulk reads (cheaper).

### Errors we handle explicitly

- **Force-deleted branches.** The agent re-pushes; if the user deleted the PR's branch, the changeset is failed with a human-readable explanation.

Force-pushed base-branch rebase and cross-changeset file-conflict resolution are Planned, not implemented.

## Cross-cutting policies

- All git operations run with `core.autocrlf=false`, `core.filemode=false` for cross-platform stability.
- All git operations run inside the per-step abort signal scope.
- All operations are logged to the `eventlog` with skill-level grain (no raw secrets, no full diffs at log level).

## Adding a new VCS adapter

A new vendor adapter (GitLab, Gitea, GitHub Enterprise on a custom base URL, …) needs three things:

1. **An implementation of `VcsProvider`** in `packages/adapters-vcs/src/<vendor>.ts`. The interface lives in `types.ts`; `github.ts` is the reference implementation.
2. **The new adapter id added to the `VcsProvider.id` union** in `types.ts`. Callers select adapters by id; the type union keeps the switch exhaustive.
3. **A conformance test** in `packages/adapters-vcs/test/<vendor>.test.ts`. Use `test/github.test.ts` as the template — copy the file, swap the SDK / fetch mocks for your vendor's shape, and the helpers in `test/conformance.ts` will catch contract violations:
   - `openPullRequest` returns a well-shaped `PullRequest` with a valid `state`.
   - `mergePullRequest` returns a well-shaped `MergeResult`.
   - `getPullRequestFiles` returns parsed `PullRequestFile`s with a recognized `status`.
   - `verifyWebhookSignature` is HMAC-correct and timing-safe.
   - `parseWebhookEvent` extracts a valid `VcsEvent` discriminator and preserves the raw payload.

Git-shell methods (`cloneIntoWorkspace`, `createBranch`, `commit`, `push`, `fetchUpdate`) are intentionally **out of scope** for the conformance suite — they wrap `git` under `execa` and mocking the subprocess interface adds noise without much signal. The dogfood smoke (`apps/dogfood-smoke`) exercises them end-to-end against a real test repo, which catches the regressions that matter.

GitHub goes through `@octokit/rest` + `@octokit/auth-app`, so the reference test mocks both modules at the SDK seam. Adapters that hit the vendor REST API directly (no SDK) should `vi.stubGlobal('fetch', …)` instead — see `packages/adapters-deploy/test/render.test.ts` for that pattern.

Once the test passes, run `pnpm --filter @mergecrew/adapters-vcs test` locally and CI picks up the rest.

## Planned extensions

- **GitLab adapter.** Same interface; webhook differences are encapsulated.
- **Gitea / self-hosted GitHub Enterprise.** Same interface; the runner needs network access to the on-prem URL.
- **Multi-repo project.** A Project gains `ConnectedRepoRef[]` instead of a single repo, and changesets carry which repo they target. The agent runtime must reason about cross-repo coordination (e.g., shared types).
