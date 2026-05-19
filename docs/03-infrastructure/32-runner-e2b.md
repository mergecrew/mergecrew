# Runner: E2B microVM driver

The `e2b` sandbox driver runs each step in a Firecracker microVM
managed by [E2B](https://github.com/e2b-dev/infra) (#579). Snapshot-
based cold start lands well under the RFC's 5s p95 target on warm
templates, making it the right choice for operators who want
hardware-virt isolation without managing the Firecracker host service
themselves.

See `docs/02-architecture/14-runner-microvm-decision.md` for the
rationale (Apache-2.0, battle-tested, no paid SaaS, OSS contributor
ramp-up).

## Install

mergecrew never embeds an API key for hosted E2B. Self-hosted is the
default deployment shape: deploy the E2B control plane on your
infrastructure, point `RUNNER_E2B_DOMAIN` at it.

### Self-hosted E2B (recommended)

Follow [E2B's self-hosted docs](https://e2b.dev/docs/sandbox/cli/self-hosting)
to stand up the cluster on Nomad/AWS. Once the control plane is
reachable:

```sh
RUNNER_SANDBOX=e2b
RUNNER_E2B_DOMAIN=https://api.e2b.your-domain.com
# Self-hosted clusters can run without auth; if yours has the API
# gateway configured, set the matching key:
RUNNER_E2B_API_KEY=…
RUNNER_E2B_DEFAULT_TEMPLATE=mergecrew-polyglot
```

### Hosted E2B (optional)

If you must use the hosted E2B SaaS, set:

```sh
RUNNER_E2B_DOMAIN=https://api.e2b.dev
RUNNER_E2B_API_KEY=e2b_…
```

The driver itself doesn't care whether you self-host or use the
hosted control plane — same SDK, same lifecycle.

## Templates

E2B sandboxes boot from named **templates** (snapshots of a base image
+ dependencies). One template per stack:

| Template id | Base | Use |
|---|---|---|
| `mergecrew-node` | mergecrew runner-node:22 | Node-only projects |
| `mergecrew-python` | mergecrew runner-python:3.12 | Python-only projects |
| `mergecrew-polyglot` | mergecrew runner-polyglot | Mixed / default |

Build them once:

```sh
e2b template build --name mergecrew-polyglot --dockerfile infra/images/Dockerfile.runner-polyglot
```

Projects opt into a specific stack via `runner.image: mergecrew-node`
in mergecrew.yaml; the driver passes that through as the E2B template
id.

## Lifecycle

```
runner.step  ─►  E2BDriver.start()
                     │
                     ▼
                E2B Sandbox.create(template)        ─► microVM boot
                     │                                  (snapshot restore
                     ▼                                   typically < 5s)
                runner.step exec loop
                  for each exec:
                    sandbox.commands.run(sh -c …)
                  for each fs op:
                    sandbox.files.read/write
                     │
                     ▼
                E2BDriver.stop()
                     │
                     ▼
                Sandbox.kill()                      ─► microVM destroyed
```

## Cold-start metric

The driver emits `e2b.cold_start_ms` via `logger.metric` on every
start. The default 5000ms target raises a warn log when exceeded —
typically the *first* run after a template change (snapshot rebuild)
or a control-plane scale-up that drained the warm pool.

Wire the metric to your existing observability sink. Track the p95;
sustained >5s on a warm cluster usually means template caches need to
be larger (E2B's nodepool config).

## Network egress

E2B sandboxes egress through the control plane's NAT. To enforce a
project-specific hostname allowlist (#10), the operator deploys the
runner-dns sidecar (#574) on the same network and configures E2B's
node config to point sandbox `/etc/resolv.conf` at it. Combined with
the skill-layer check (`packages/skills/src/egress-policy.ts`), this
gives the same two-layer enforcement we have on the docker driver.

## Tuning

| Env | Default | Notes |
|---|---|---|
| `RUNNER_E2B_DOMAIN` | required | Control plane URL. |
| `RUNNER_E2B_API_KEY` | empty | Required for hosted E2B; optional for self-hosted. |
| `RUNNER_E2B_DEFAULT_TEMPLATE` | `mergecrew-polyglot` | Used when project sets no `runner.image`. |
| `coldStartTargetMs` (driver) | 5000ms | SLA used for the warn log; doesn't change behavior. |

## Troubleshooting

**Cold start >5s every time, not just on first run.**
Your warm pool is too small. In E2B's Nomad config, raise the
`scheduler.warmpool_size` for the template's nodepool.

**`Sandbox.create` rejects with 401.**
Hosted E2B without `RUNNER_E2B_API_KEY` set, or self-hosted E2B with
the API gateway enforcing auth that mergecrew isn't presenting. Set
the key to match.

**Template not found.**
The build step never landed, or the supervisor and the control plane
disagree on the namespace. List with `e2b template ls`.

**File I/O hangs.**
The sandbox died between `start()` and the file op. Check the E2B
control plane logs; the supervisor logs the sandbox id (`sbx-…`)
which is searchable in E2B's UI.

## See also

- `packages/sandbox-driver/src/e2b-driver.ts`
- `packages/sandbox-driver/src/e2b-api-client.ts`
- `docs/02-architecture/14-runner-microvm-decision.md` — ADR.
- `docs/02-architecture/13-runner-isolation.md` § 5.1, § 5.5, § 6.
- `docs/03-infrastructure/30-runner-kubernetes.md`,
  `31-runner-fargate.md` for the comparable per-step Job/task flows.
