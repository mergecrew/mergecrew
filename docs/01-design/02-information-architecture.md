# Information architecture

## Top-level navigation

```
┌──────────────────────────────────────────────┐
│  Mergecrew                                       │
│  ─────────                                   │
│  Today           ← landing for an org        │
│  Projects        ← list & create             │
│  Inbox           ← pending approvals         │
│  Activity        ← org-wide timeline         │
│  Costs           ← spend & budgets           │
│  Settings        ← org & members             │
└──────────────────────────────────────────────┘
```

`Today` is the org-wide rollup of: in-flight runs, pending approvals, last night's digest items not yet decided, anomalies. It's the landing surface after sign-in.

## Project-level navigation

```
Project: <repo name>
─────────────────────
Overview          ← health, run schedule, last run summary
Timeline          ← live agent activity (per-day view)
Changesets        ← all changesets, filterable
Digest (today)    ← today's review surface
Lifecycle         ← workflow graph viewer/editor
Agents            ← roster, model assignments, skills
Settings          ← repo, deploy targets, gates, secrets
History           ← past runs, transcripts, decisions
```

## Hierarchy of objects

```
Organization
└── Member (via Membership: role)
└── Project
    ├── ConnectedRepo (1)
    ├── DeployTarget (n)  — dev / staging / prod
    ├── Lifecycle (versioned, sourced from mergecrew.yaml)
    │   └── Workflow (n)
    │       ├── Agent (n)        — instance of an AgentKind, project-scoped
    │       │   └── Skill (n)    — instance of a SkillKind, agent-scoped
    │       └── Transition (n)
    │           └── Gate         — auto / notify / require-approval
    ├── DailyRun (n)
    │   └── WorkflowRun (n)
    │       └── AgentStep (n)
    │           ├── ToolCall (n)
    │           └── ModelTurn (n)
    ├── Changeset (n)
    │   ├── PR (1)
    │   ├── DevDeploy (1)
    │   ├── TestResult (1)
    │   ├── Decision (0..n: promote/rollback/defer)
    │   └── PromotedDeploy (0..1)
    ├── ApprovalRequest (n)
    └── IntentInboxItem (n)
```

## URL structure

```
/                                       → Today (if logged in)
/login
/signup
/orgs/:org_slug                         → org Today
/orgs/:org_slug/inbox
/orgs/:org_slug/activity
/orgs/:org_slug/costs
/orgs/:org_slug/settings
/orgs/:org_slug/settings/members
/orgs/:org_slug/settings/integrations
/orgs/:org_slug/settings/billing
/orgs/:org_slug/projects
/orgs/:org_slug/projects/new
/orgs/:org_slug/projects/:project_slug
/orgs/:org_slug/projects/:project_slug/timeline
/orgs/:org_slug/projects/:project_slug/timeline/:date
/orgs/:org_slug/projects/:project_slug/changesets
/orgs/:org_slug/projects/:project_slug/changesets/:changeset_id
/orgs/:org_slug/projects/:project_slug/digest                ← today's
/orgs/:org_slug/projects/:project_slug/digest/:date          ← historical
/orgs/:org_slug/projects/:project_slug/lifecycle
/orgs/:org_slug/projects/:project_slug/agents
/orgs/:org_slug/projects/:project_slug/agents/:agent_id
/orgs/:org_slug/projects/:project_slug/runs/:run_id
/orgs/:org_slug/projects/:project_slug/runs/:run_id/transcript/:agent_step_id
/orgs/:org_slug/projects/:project_slug/settings
```

URL design notes:

- Org slug always present. There is no implicit "current org" in the URL — switching orgs is a navigation, not a session toggle. This avoids the classic multi-tenant footgun where a user thinks they're acting on org A but are acting on org B.
- Changeset IDs are short, opaque, URL-safe (e.g., `cs_2tA9X`). Used in Slack and email links.
- Run IDs include the date for readability (e.g., `run_2026-05-08_p1`).

## Notification surfaces

| Trigger | Surface | Default |
|---|---|---|
| Daily run started | none | off |
| Approval needed (sensitive change) | Slack DM + email + inbox | on |
| Daily digest ready | Slack DM + email | on |
| Run failed | Slack DM (Owner) + inbox | on |
| Changeset rolled back from prod | Slack DM (Owner) | on |
| Provider rate-limit pause >2h | Slack DM | on |

Notifications respect per-user quiet hours (defaulting to org working-hours).

## Empty states

Every primary surface has a designed empty state, not a blank page:

- `Today` with no orgs → "Create your first organization" CTA.
- `Projects` with none → "Connect your first GitHub repo" CTA.
- `Timeline` for a day with no run → "No run today. Schedule one or run now."
- `Inbox` empty → "Nothing pending. The agents are working." (with last-activity timestamp)
- `Digest` mid-run → "Today's digest is being assembled. Estimated ready: 17:00." (with progress strip)

## Density modes

The web UI supports two density modes:

- **Comfortable** (default) — one row per timeline event, generous spacing.
- **Compact** — for power users (Mira) who want to see a full day's activity in one viewport.

Mobile is always Comfortable.
