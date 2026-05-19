# Runner: AWS Fargate driver

The `fargate` sandbox driver runs each step as an ECS task on Fargate
(#578). Hardware-virt isolation via Fargate's per-task microVM, no VM
management on the operator's side. Best for AWS-native operators who
want the cleanest isolation story without running their own cluster.

## Trade-off

- **Pro:** Per-task microVM; AWS handles the host.
- **Con:** 30–60s cold start per task. The supervisor emits the
  `fargate.cold_start_ms` metric so operators can right-size their
  expectations.

If your steps are short (< 30s of actual work), prefer the `docker`
or `kubernetes` drivers — the cold-start tax dominates.

## Install

```sh
cd infra/terraform/fargate-runner
terraform init
terraform apply \
  -var vpc_id=vpc-0a1b2c3d \
  -var 'private_subnet_ids=["subnet-aaa","subnet-bbb"]' \
  -var 'egress_cidrs=["140.82.121.0/24","185.199.108.0/22"]'  # github.com + githubusercontent
```

The module outputs `cluster_name`, `task_definition_family`,
`security_group_id`, `subnet_ids`. Wire them into the supervisor:

```sh
RUNNER_SANDBOX=fargate
RUNNER_FARGATE_REGION=us-east-1
RUNNER_FARGATE_CLUSTER=mergecrew-runner
RUNNER_FARGATE_TASK_DEFINITION=mergecrew-runner
RUNNER_FARGATE_SUBNETS=subnet-aaa,subnet-bbb
RUNNER_FARGATE_SG=sg-1234567890abcdef0
```

## Image contract

The Fargate sandbox image MUST include the AWS Systems Manager (SSM)
agent so the supervisor can dispatch commands via ECS Execute Command.
The mergecrew base images (`runner-polyglot`, `runner-node`, …) bake
this in. If you supply a custom image, install the agent (Amazon
Linux: `yum install -y amazon-ssm-agent`).

The image runs as uid 1001 (mergecrew user) with readOnlyRootFilesystem
and a tmpfs `/tmp` and `/home/mergecrew`. The workspace is a Docker
volume mounted at `/workspace`.

## Egress

The Terraform module attaches a security group with an egress allowlist
constructed from `var.egress_cidrs`. Empty list = no outbound. Combine
with the project-level allowlist (#10) for layered control:

- **VPC layer (this):** which CIDRs can be reached at all.
- **Project layer (skill code):** which hostnames are allowed.

For DNS resolution, the sandbox uses the VPC resolver. To enforce a
project-specific allowlist at DNS, point the task at a runner-dns
sidecar (#574) deployed as a second container or as a separate task on
the same subnet.

## IAM scope

The task role granted by the Terraform module is minimal:

```
ssmmessages:CreateControlChannel
ssmmessages:CreateDataChannel
ssmmessages:OpenControlChannel
ssmmessages:OpenDataChannel
logs:CreateLogStream / DescribeLogStreams / PutLogEvents
```

No `kms:*`, no `secretsmanager:*`, no `s3:*`. The supervisor mediates
any credential the sandbox would otherwise read (#554 threat T-5).

## ECS Execute Command

The driver dispatches each `exec()` as
`aws ecs execute-command --interactive --command 'sh -c "…"'`. This
shells out to the AWS CLI v2 + `session-manager-plugin` on the
supervisor host (because the SSM session protocol is non-trivial in
pure Node). Both are required:

```sh
apt-get install -y awscli
# session-manager-plugin per
# https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html
```

A pure-Node session implementation is a documented follow-up. The seam
(`FargateApiClient.executeCommand`) is stable — swap implementations
without touching the driver.

## Tuning

| Env / TF var | Default | Notes |
|---|---|---|
| `RUNNER_FARGATE_REGION` | required | Same region as the cluster. |
| `RUNNER_FARGATE_CLUSTER` | from Terraform | Cluster name or full ARN. |
| `RUNNER_FARGATE_TASK_DEFINITION` | from Terraform | Family or full ARN. |
| `RUNNER_FARGATE_SUBNETS` | from Terraform | Comma-separated; should be private subnets. |
| `RUNNER_FARGATE_SG` | from Terraform | Restricts task egress. |
| `task_cpu` (TF) | 1024 | Fargate vCPU units; must match memory matrix. |
| `task_memory` (TF) | 2048 | MB. |
| `assignPublicIp` (driver) | false | Force traffic through NAT, never direct IGW. |

## Cold-start metric

The driver emits `fargate.cold_start_ms` via `logger.metric` on every
successful start. Wire it to CloudWatch or your existing OTel/Prometheus
sink to track cold-start regressions; a typical p50 is 30–60s, p99 up
to 120s. Anything beyond is usually image-pull issues (verify the
ImagePullPolicy and Fargate platform version).

## Troubleshooting

**"fargate task X did not become RUNNING within 120000ms"**
Most often: image pull from a private registry without `repositoryCredentials`, or
the task subnet has no route to the registry. Inspect events with:
```sh
aws ecs describe-tasks --cluster mergecrew-runner --tasks <id>
```

**`UnableToStartSession`** in `executeCommand`
The task IAM role is missing `ssmmessages:*` (check Terraform applied)
or the SSM agent isn't running in the container image.

**Cold start > 2 minutes consistently**
Check the platform version (Fargate 1.4.0+ recommended) and consider
keeping a warm pool of tasks; the driver can be extended to pull from
that pool instead of `runTask` if cold start is unacceptable.

## See also

- `packages/sandbox-driver/src/fargate-driver.ts`
- `packages/sandbox-driver/src/fargate-api-client.ts`
- `infra/terraform/fargate-runner/main.tf`
- `docs/02-architecture/13-runner-isolation.md` § 5.1, § 7
- `docs/03-infrastructure/30-runner-kubernetes.md` for the
  comparable k8s flow.
