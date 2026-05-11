/**
 * Maps known failure-event types and payload reasons to their stable
 * anchor in the operator runbook (#251). The timeline renderer calls
 * `runbookLinkFor(event)` and, when it returns a non-null result,
 * appends a "What does this mean?" link beside the event row.
 *
 * Anchors are explicit `<a id="…">` tags inside
 * `docs/03-infrastructure/05-operator-runbook.md` so the links stay
 * stable across heading edits.
 */

const RUNBOOK_URL =
  'https://github.com/mergecrew/mergecrew/blob/main/docs/03-infrastructure/05-operator-runbook.md';

export interface RunbookLink {
  href: string;
  label: string;
}

interface MinimalEv {
  type: string;
  payload?: unknown;
}

function anchor(slug: string): string {
  return `${RUNBOOK_URL}#${slug}`;
}

/**
 * Returns the runbook anchor for a timeline event, or null if the
 * event isn't a known failure mode with a documented recovery.
 */
export function runbookLinkFor(event: MinimalEv): RunbookLink | null {
  const reason = (event.payload as { reason?: string } | undefined)?.reason;

  if (event.type === 'AGENT_STEP_FAILED') {
    if (reason === 'runner_dead') {
      return { href: anchor('step-stuck-running'), label: 'What does this mean?' };
    }
    if (reason === 'org_daily_budget_exhausted' || reason === 'budget_exhausted') {
      return { href: anchor('budget-exhausted'), label: 'What does this mean?' };
    }
    if (reason === 'gated_reject') {
      return { href: anchor('gated-reject'), label: 'What does this mean?' };
    }
  }

  // Surfaced from the deploy adapter's awaitCompletion via the runner's
  // CHANGESET_DEV_DEPLOY_FAILED event, or whatever the existing event is.
  // Keep both spellings until the codebase consolidates on one.
  if (reason === 'deploy_timeout' || reason === 'timeout') {
    return { href: anchor('deploy-timeout'), label: 'What does this mean?' };
  }

  if (reason === 'vcs_clone_failed') {
    return { href: anchor('vcs-clone-failed'), label: 'What does this mean?' };
  }

  return null;
}
