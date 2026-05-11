/**
 * The full set of telemetry events Mergecrew is allowed to emit (#253).
 *
 * **Privacy invariants** — non-negotiable, enforced by the type system:
 *   - No org/project/user identifiers (no slugs, no emails, no IPs).
 *   - No content (no repo names, no PR titles, no agent outputs).
 *   - Only the documented fields below; every new field needs a PR
 *     that updates the schema and the auditable docs.
 *
 * Each event carries a per-install random UUID (`installId`) generated
 * lazily on the org's first opt-in (see `Organization.telemetryInstallId`
 * in the Prisma schema). That UUID is the only "who" identifier.
 */

export type TelemetryEvent =
  | OrgCreatedEvent
  | ProjectCreatedEvent
  | IntegrationConnectedEvent
  | RunCompletedEvent
  | WizardBailedEvent
  | OrgCapHitEvent;

interface BaseEvent {
  /** Per-install random UUID — the only identifier on the payload. */
  installId: string;
  /** ISO 8601 timestamp the event was generated. */
  occurredAt: string;
  /** Mergecrew version that emitted the event. Read from package.json. */
  version: string;
}

export interface OrgCreatedEvent extends BaseEvent {
  type: 'org.created';
  /** No payload fields beyond the base — we only count org-create events. */
}

export interface ProjectCreatedEvent extends BaseEvent {
  type: 'project.created';
  /**
   * Whether the new project finished onboarding with a connected repo
   * + dev deploy target, or stayed paused (V2.x #229). Lets us measure
   * onboarding completion rate without knowing *which* projects.
   */
  paused: boolean;
}

export interface IntegrationConnectedEvent extends BaseEvent {
  type: 'integration.connected';
  /** Provider kind only — never the credentials, org/project slug, repo, etc. */
  provider:
    | 'github'           // VCS
    | 'gitlab'           // VCS
    | 'gitea'            // VCS
    | 'github-actions'   // deploy
    | 'vercel'           // deploy
    | 'netlify'          // deploy
    | 'aws-direct'       // deploy
    | 'fly'              // deploy
    | 'render'           // deploy
    | 'railway'          // deploy
    | 'linear'           // tracker
    | 'github-issues'    // tracker
    | 'sentry';          // error tracker
}

export interface RunCompletedEvent extends BaseEvent {
  type: 'run.completed';
  /** Mirrors the daily_run_status enum minus paused_* (not terminal). */
  status: 'done' | 'failed' | 'cancelled';
}

export interface WizardBailedEvent extends BaseEvent {
  type: 'wizard.bailed';
  /**
   * Which wizard step the operator left from. Helps us see where the
   * onboarding flow loses people without recording who left.
   */
  step: 'create-project' | 'connect-repo' | 'deploy-target' | 'tracker';
}

export interface OrgCapHitEvent extends BaseEvent {
  type: 'org.cap_hit';
  /**
   * Which guardrail blocked the run. Today only monthly_spend; future
   * caps (daily_spend, blast_radius, risk_score) will join this union
   * rather than spawning new event types — keeps the telemetry surface
   * small (#282).
   */
  capKind: 'monthly_spend';
  /** Bucketed to the nearest \$10 to avoid leaking precise per-org cost. */
  spentUsdBucket: number;
  /** The cap value at the time of the hit, also bucketed to \$10. */
  capUsdBucket: number;
}
