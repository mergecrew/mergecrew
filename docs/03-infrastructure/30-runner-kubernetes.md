# Runner: Kubernetes driver

The mergecrew runner can dispatch each step into a per-run Kubernetes
Job instead of running the build on the supervisor host (`process`) or
inside a local Docker container (`docker`). The `kubernetes` driver
(#577) is the right choice when you already operate a cluster:
existing observability + scaling + node-pool isolation extend to the
sandbox without bespoke infrastructure.

## When to pick this

| You have… | Choose |
|---|---|
| One host, low volume, OSS demo | `process` |
| One host, want isolation now | `docker` |
| A cluster, want N supervisors + N sandbox pods | **`kubernetes`** |
| EKS/GKE with mature NetworkPolicy CNI | **`kubernetes`** |

If you're on Fargate, see #578 (Fargate task driver).

## Architecture

```
┌─────────────────────────────┐    BullMQ queue        ┌────────────────────────┐
│ orchestrator (api-side)     │ ───────────────────►   │ runner Deployment       │
└─────────────────────────────┘                        │  (mergecrew-runner ns)  │
                                                       │                         │
                                                       │  RUNNER_SANDBOX=        │
                                                       │      kubernetes         │
                                                       │  RUNNER_K8S_NAMESPACE=  │
                                                       │      mergecrew-runners  │
                                                       └──────────┬──────────────┘
                                                                  │ create
                                                                  ▼
                                                       ┌────────────────────────┐
                                                       │ mergecrew-runners ns   │
                                                       │                        │
                                                       │  Job: mergecrew-<id>   │
                                                       │    └── Pod (1×)        │
                                                       │        - runAsUser     │
                                                       │          1001          │
                                                       │        - readOnlyRoot  │
                                                       │        - capDrop ALL   │
                                                       │  NetworkPolicy:        │
                                                       │     mergecrew-<id>-eg  │
                                                       │     (deny-all + DNS)   │
                                                       └────────────────────────┘
```

## Install

```sh
helm install runner ./infra/k8s/runner \
  --namespace mergecrew-runner --create-namespace \
  --set image.repository=ghcr.io/mergecrew/runner \
  --set image.tag=v0.1.0 \
  --set sandboxNamespace=mergecrew-runners \
  --set externalSecrets.redisUrl=mergecrew-redis \
  --set externalSecrets.databaseUrl=mergecrew-postgres
```

The chart creates:

- `Namespace mergecrew-runners` (the sandbox ns) with PodSecurity
  `restricted` enforced, plus a baseline `NetworkPolicy: deny-all-egress`
  that catches any pod the K8sDriver might miss.
- `Deployment` + `ServiceAccount` for the supervisor, with a Role +
  RoleBinding scoped to the sandbox namespace only: create/delete Jobs
  & NetworkPolicies, exec into Pods, get logs. No cluster-wide rights.
- Secrets references (the chart never inlines credentials; create
  `mergecrew-redis` / `mergecrew-postgres` separately).

## Per-Job security context

Every Job the K8sDriver creates carries the following baked-in
hardening (see `packages/sandbox-driver/src/k8s-api-client.ts`):

```yaml
spec:
  template:
    spec:
      automountServiceAccountToken: false
      securityContext:
        runAsUser: 1001
        runAsGroup: 1001
        runAsNonRoot: true
        seccompProfile: { type: RuntimeDefault }
      containers:
        - securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities: { drop: ["ALL"] }
            runAsUser: 1001
      volumes:
        - { name: workspace, emptyDir: {} }
        - { name: tmp,       emptyDir: { medium: Memory, sizeLimit: 512Mi } }
        - { name: home,      emptyDir: { medium: Memory, sizeLimit: 512Mi } }
```

`ttlSecondsAfterFinished: 300` is set on the Job so the cluster GC
removes the Pod even if the supervisor crashes before stop().

## Per-run NetworkPolicy

A `NetworkPolicy` is created alongside each Job, selecting on the
Pod's `mergecrew.io/run-id` label. The default policy denies all
egress except DNS (UDP+TCP/53), so the per-run DNS resolver (#574)
still works.

When the project has `runner.egress.allow` set, the policy additionally
permits TCP/80 + TCP/443 — host-level filtering is then enforced at the
CNI layer (the cluster's equivalent of nftables, #573).

## Workspace I/O

Skill-level `readFile`/`writeFile` go through `kubectl exec`-style
calls (cat/tee). This avoids requiring a shared volume between the
supervisor and the sandbox at the cost of throughput; build steps run
*inside* the sandbox and write to `/workspace` (an emptyDir), so the
expensive I/O happens locally to the Pod.

A future iteration may dynamically provision a PVC and surface it via
`SandboxStartOpts.workspacePvc` — set `workspaceStorageClass` in the
chart values to opt in once that lands.

## Tuning

| Env / value | Default | Notes |
|---|---|---|
| `RUNNER_K8S_NAMESPACE` | required | Sandbox namespace. Must differ from the supervisor's. |
| `RUNNER_K8S_AUTH` | `default` | `in-cluster` when supervisor runs in the same cluster (typical). |
| `RUNNER_K8S_DEFAULT_IMAGE` | `runner-polyglot:latest` | Image used when project has no `runner.image`. |
| `podReadyTimeoutMs` (constructor) | 60s | How long start() waits for the Pod to be ready before failing. |
| `ttlSecondsAfterFinished` | 300s | Belt-and-braces cleanup if the supervisor dies. |
| `replicas` (Helm) | 1 | Per-pod step concurrency is `RUNNER_CONCURRENCY`; total concurrency = replicas × concurrency. |

## Troubleshooting

**"pod for job X did not become ready within 60000ms"**
The image pull is slow or fails. Check Pod events:
`kubectl -n mergecrew-runners describe pod -l job-name=X`. Common
causes: private registry without imagePullSecret, image platform
mismatch (linux/amd64 vs linux/arm64), wrong tag.

**Build's `npm install` fails with `ENOTFOUND`**
The per-run NetworkPolicy blocked DNS for that hostname or the host
isn't on the project allowlist. The run-detail "Network" section
(#576) shows the rejected hosts. Add them to the project allowlist
from Settings.

**Job stays Running after supervisor restart**
The supervisor's in-memory `records` map is empty after restart, so
`stop()` no longer knows about live Jobs. The `ttlSecondsAfterFinished`
ceiling (5 min) still applies; for cluster-wide cleanup of orphaned
Jobs, label-select on `app.kubernetes.io/managed-by=mergecrew-runner`
and delete those older than the runtime ceiling.

**`pods "X" is forbidden: User cannot exec into pods`**
The RoleBinding is missing in the sandbox namespace. Re-run
`helm upgrade` and verify with:
`kubectl -n mergecrew-runners auth can-i create pods/exec --as=system:serviceaccount:mergecrew-runner:runner`.

## See also

- `packages/sandbox-driver/src/k8s-driver.ts` — driver implementation.
- `packages/sandbox-driver/src/k8s-api-client.ts` — the
  `@kubernetes/client-node` adapter behind it.
- `docs/02-architecture/13-runner-isolation.md` § 5.1, § 7 — RFC.
- `docs/03-infrastructure/22-runner-images.md` — base image contract.
- `docs/03-infrastructure/23-runner-network-policy.md` — comparable
  netfilter ruleset used by the Docker driver.
