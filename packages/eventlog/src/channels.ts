/**
 * Cross-service Redis pubsub channel for run cancellation (V1.3, #9).
 *
 * The API publishes here when a user cancels a run. The runner subscribes
 * and aborts the AbortController for any in-flight step belonging to the
 * cancelled run. The orchestrator also reads this signal to drop queued
 * steps before they reach the runner.
 *
 * One channel + payload-routing (rather than per-run channels) keeps the
 * Redis subscription count flat at O(services) instead of O(active runs).
 */
export const RUN_CANCEL_CHANNEL = 'mergecrew:run-cancel';

export interface RunCancelMessage {
  organizationId: string;
  runId: string;
  /** Optional human-readable reason; surfaced in step outcomes. */
  reason?: string;
}
