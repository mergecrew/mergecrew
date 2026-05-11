# Skill SDK

Skills are the only way an agent can act on the outside world. The runner registers a `SkillExecutor` per step and the agent loop chooses which skill to invoke from its declared toolset. Every skill is a single object that declares its name, schemas, side-effect classification, capabilities, and an `execute(input, ctx)` body.

This document is for authors: someone adding a Jira tracker adapter, a Honeycomb error-source skill, a CRM webhook integration, or just a small project-specific helper.

## Two extension points

Pick by how much code you want to write.

### HTTP-backed custom skill — `mergecrew.yaml`

Declare a skill in your project's `mergecrew.yaml` under `skills:`. The runner builds a runnable skill on the fly via `buildHttpSkill` (`packages/skills/src/http-skill.ts`): the agent's input gets POSTed to your `endpoint`, the JSON response becomes the skill output. Nothing to fork; you can host the endpoint anywhere.

```yaml
# mergecrew.yaml
skills:
  pagerduty.silence_service:
    description: |
      Silence a PagerDuty service for the next N minutes. Use after a
      noisy alert to suppress pages while a fix is in flight.
    inputSchema:
      type: object
      properties:
        serviceId: { type: string }
        minutes:   { type: integer, minimum: 1, maximum: 240 }
      required: [serviceId, minutes]
      additionalProperties: false
    outputSchema:
      type: object
      properties:
        maintenanceWindowId: { type: string }
    sideEffectClass: write_external
    endpoint: https://hooks.example.com/mergecrew/pagerduty-silence
```

What the runner does at call time:

1. Validates the host against the project's `egress_allowlist` (`packages/skills/src/egress-policy.ts`).
2. POSTs `{ "input": <the agent's args> }` to `endpoint` with `x-mergecrew-org-id`, `x-mergecrew-project-id`, and `x-mergecrew-run-id` headers.
3. Returns the response body as the skill output. Non-2xx → the agent sees a tool error and decides what to do.

This is the **lowest-barrier** path: no code change in this repo, no redeploy of the runner. Use it when:

- The work is a single HTTP call against a vendor API.
- You're OK with the policy engine treating it as net.outbound + the declared `sideEffectClass`.
- You don't need workspace access (file reads, git operations).

### Code-backed stock skill — `packages/skills/src/stock/`

When the work is multi-step, needs the runner's workspace, or needs deeper policy hooks (sensitive-path patterns, capability-based gating), add it as TypeScript under `packages/skills/src/stock/<area>.ts` and append to the array exported from there. The catalog at `packages/skills/src/catalog.ts` flattens every area into `stockSkills`, which the runner registers wholesale.

Use this path when:

- You need to read or write files in the runner workspace (`ctx.workspacePath`).
- You need an injected adapter — the VCS provider for git operations, the deploy provider for status polling, the tracker provider, comms.
- You need to call an LLM via the project's configured provider (`ctx.config.llm.chat`).
- The work is meaningfully bigger than one HTTP request and benefits from being a single named tool.

## The skill shape

Every skill conforms to `SkillDefinition` (`packages/skills/src/types.ts`):

```ts
interface SkillDefinition<I = unknown, O = unknown> {
  name: string;                          // dotted lowercase: tracker.list_issues
  description: string;                   // shown to the agent — make it specific
  inputSchema: Record<string, unknown>;  // JSON Schema for tool-call inputs
  outputSchema?: Record<string, unknown>;
  sideEffectClass: 'read' | 'write_workspace' | 'write_external' | 'irreversible';
  capabilities: SkillCapability[];       // see the union in types.ts
  timeoutMs?: number;                    // default 60_000
  execute: (input: I, ctx: SkillExecutionContext) => Promise<SkillResult<O>>;
}
```

A few non-obvious fields worth understanding before you write your first skill:

### `sideEffectClass`

| Class | When | Examples |
| --- | --- | --- |
| `read` | Pure observation — reading files, listing issues, fetching a URL. | `repo.read_file`, `tracker.list_issues`, `web.smoke_check` |
| `write_workspace` | Mutates the per-step workspace only. The workspace is thrown away after the step, so this is reversible. | `repo.write_file`, `repo.git.create_branch` |
| `write_external` | Reaches outside the workspace and changes shared state. Reversible in principle but only by the operator. | `repo.git.commit`, `tracker.create_issue`, `comms.send_email` |
| `irreversible` | Cannot be undone — production rollouts, account deletions, billing actions. Forces a human approval gate regardless of project settings. | (Reserved — no stock skill claims this today.) |

The class drives the policy engine's gate decisions. Mis-classifying a `write_external` skill as `read` is one of the few things conformance won't catch automatically — be honest about side effects.

### `capabilities`

The capability union is the closed set in `packages/skills/src/types.ts`. The agent's policy decides what each capability needs (network egress allowlist, sensitive-path gates, etc.). For HTTP-backed skills the runner sets `['net.outbound']` automatically. For stock skills, list every capability you actually use — if your skill calls `fetch` it needs `net.outbound`; if it calls `git commit` via the VCS adapter it needs `git.commit`. The conformance test verifies the capability list isn't empty and matches the closed enum.

### `ctx` — the execution context

`SkillExecutionContext` carries everything a skill is allowed to touch: the tenant ids, the workspace path (only set for steps that have a workspace), an abort signal, a logger, adapters injected at step boot, the egress allowlist, and a per-skill `config` bag. **Don't reach for globals** — the executor passes ctx so secrets, tenant scope, and abort propagation all stay correct.

## Walkthrough: PagerDuty silence-service skill (HTTP-backed)

Start to finish in five steps. We'll wire the skill above into a custom `incident_response` agent that the lifecycle invokes after the bug-triage step.

### 1. Stand up the endpoint

Your endpoint is responsible for taking `{ input: { serviceId, minutes } }` (POSTed JSON) and calling PagerDuty's REST API. A 30-line Cloudflare Worker or a Lambda Function URL is plenty. Keep your PagerDuty API token in your endpoint's secret store — never in `mergecrew.yaml`.

```js
// worker.js (Cloudflare Worker shape)
export default {
  async fetch(req, env) {
    const { input } = await req.json();
    const r = await fetch('https://api.pagerduty.com/maintenance_windows', {
      method: 'POST',
      headers: {
        Authorization: `Token token=${env.PAGERDUTY_TOKEN}`,
        Accept: 'application/vnd.pagerduty+json;version=2',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        maintenance_window: {
          type: 'maintenance_window',
          start_time: new Date().toISOString(),
          end_time: new Date(Date.now() + input.minutes * 60_000).toISOString(),
          services: [{ id: input.serviceId, type: 'service_reference' }],
        },
      }),
    });
    if (!r.ok) return new Response(await r.text(), { status: r.status });
    const data = await r.json();
    return Response.json({ maintenanceWindowId: data.maintenance_window.id });
  },
};
```

### 2. Declare the skill in `mergecrew.yaml`

Use the YAML block at the top of this document. Make sure the host is in the project's `egress_allowlist` (settable from the project settings page or the YAML's `human_gates.sensitive_path_patterns` siblings).

### 3. Wire it into an agent

```yaml
agents:
  incident_responder:
    kind: SRE
    description: |
      Reacts to live incidents: silences the noisy service, files a
      tracker issue, posts a context-rich summary to the incident channel.
    systemPrompt: |
      You are the Incident Responder.
      Workflow: silence the right service first, file an issue with the
      relevant error fingerprint, then post a summary.
    skills:
      - pagerduty.silence_service
      - tracker.create_issue
      - comms.send_slack
```

### 4. Wire the agent into the lifecycle

```yaml
lifecycle:
  workflows:
    - id: observation
      agents: [observation, bug_triage, incident_responder]
      out: []
```

### 5. Save and run

The next scheduled run picks up the new YAML. On a real incident, the agent calls `pagerduty.silence_service` with `{serviceId: 'P123', minutes: 30}`, the runner POSTs to your worker, your worker calls PagerDuty, and the maintenance window id round-trips back as the tool output. The runner records this as a `repo.git.*`-style tool call in the eventlog, complete with the policy decision, the input, and the output.

End-to-end well under 30 minutes if your endpoint is already wired up; another half hour to deploy the worker if it isn't.

## Walkthrough: a code-backed stock skill

The shape mirrors the existing skills in `packages/skills/src/stock/`. Copy-paste a representative neighbor — `tracker.ts` for adapter-backed read+write skills, `repo.ts` for workspace-touching ones — and adjust the body. Two things to remember:

1. **Don't import from outside `@mergecrew/skills` and `@mergecrew/domain`.** Skills are leaf code; the runner injects everything via `ctx`. If you find yourself reaching for the database client or BullMQ, the work probably belongs in the runner or orchestrator, not a skill.
2. **Export from the area-specific array** and add to `catalog.ts` if you're creating a new area file. The conformance test runs across `stockSkills` on every CI build, so a missing classification or capability gets caught immediately.

A minimal new stock skill for a hypothetical `tracker.assign_issue`:

```ts
// packages/skills/src/stock/tracker.ts
const trackerAssignIssue: AnySkill = {
  name: 'tracker.assign_issue',
  description: 'Assign an issue to a user in the configured tracker.',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      assignee: { type: 'string' },
    },
    required: ['id', 'assignee'],
    additionalProperties: false,
  },
  sideEffectClass: 'write_external',
  capabilities: ['tracker.write', 'net.outbound'],
  timeoutMs: 30_000,
  async execute(input: any, ctx) {
    if (!ctx.adapters.tracker) {
      throw new ValidationError('tracker.assign_issue: tracker adapter required');
    }
    await ctx.adapters.tracker.assignIssue({ id: input.id, assignee: input.assignee });
    return { output: { ok: true }, brief: `assigned ${input.id} → ${input.assignee}` };
  },
};

export const trackerSkills: AnySkill[] = [
  // ...existing skills,
  trackerAssignIssue,
];
```

This requires extending the `TrackerProvider` interface in `packages/adapters-tracker/src/types.ts` with the new method and implementing it in each tracker adapter — but the skill itself is the seven lines above.

## Testing

The package ships two tiers of test:

- **Conformance** — `packages/skills/test/conformance.test.ts` runs across `stockSkills` and asserts: dotted lowercase name, plausible JSON Schema, valid side-effect class, non-empty capabilities, side-effect ↔ capability consistency, positive timeoutMs. **Every new stock skill** picks this up automatically; you don't have to add a test for the boilerplate.
- **Behavior** — per-skill, only when there's logic worth covering. The pattern lives in `packages/skills/test/stock-repo.test.ts`: stub the adapter the skill needs (or `fetch`, for HTTP-style skills) via vitest's `vi.fn()`, build an `SkillExecutionContext` via the helpers in `harness.ts`, and call `skill.execute(input, ctx)`. Assert on `output`, `brief`, and any adapter calls.

For HTTP-backed custom skills declared in `mergecrew.yaml`, the test surface is your endpoint's own test suite — Mergecrew can't really validate something whose code lives elsewhere. The conformance assertions in the schema (`CustomSkillDef` in `packages/domain/src/lifecycle.ts`) catch declaration-time mistakes; runtime failures from your endpoint surface to the agent as tool errors.

## Where to look in the source

| Concern | File |
| --- | --- |
| Skill type interface | `packages/skills/src/types.ts` |
| HTTP custom skill builder | `packages/skills/src/http-skill.ts` |
| Executor (timeout, abort composition) | `packages/skills/src/executor.ts` |
| Stock skill catalog | `packages/skills/src/catalog.ts` |
| Stock skills by area | `packages/skills/src/stock/<area>.ts` |
| Egress allowlist enforcement | `packages/skills/src/egress-policy.ts` |
| Per-step context construction (runner) | `apps/runner/src/step.ts` |
| Conformance test | `packages/skills/test/conformance.test.ts` |
| YAML schema for custom skills | `packages/domain/src/lifecycle.ts` (`CustomSkillDef`) |
