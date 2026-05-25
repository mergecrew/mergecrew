# Runner profile: `fargate_byo` (BYO AWS account)

The `fargate_byo` runner profile executes this org's steps as ECS tasks **in your own AWS account**, via STS role assumption. The deployment never stores AWS access keys; only the role ARN + a per-org external ID.

Decision rationale: [ADR-0007](../adrs/0007-byo-cloud-credentials.md).

## Status

Working end-to-end as of V2.ag (#786). Configuration UI lives at **Settings → Runner → BYO Fargate (your account)**: role ARN, region, cluster, task definition, subnets, security groups. The per-org `awsExternalId` is generated on first save and shown back in the UI for pasting into your trust policy.

**What happens on dispatch:**

1. The orchestrator routes the step to the supervisor's queue with a `fargate-byo` executor marker (+ LPUSHes a claim onto the org's agent queue).
2. The supervisor mints a fresh per-step runner-agent token, does `sts:AssumeRole` into your role using the external ID, and calls `ecs:RunTask` to launch a Fargate task running `mergecrew/runner-agent` with the token in env.
3. The agent inside the task `/poll`s the claim, switches to sandbox-ops mode, and serves shell ops back to the supervisor.
4. When `runStep` finishes, the supervisor pushes a `step-done` sentinel and the ECS task exits cleanly.

The token is **per-step ephemeral** — the deployment writes only its sha256 hash to `runner_agents`. No long-lived AWS keys are stored on the deployment either: every dispatch gets fresh 1-hour creds via STS.

> **Trust note.** The agent token transits via ECS task env vars, visible to anyone in your AWS account with `ecs:DescribeTasks` on the cluster. For tighter posture, route the token through AWS Secrets Manager — tracked as a follow-up.

## Provisioning your AWS account

### 1. Create an IAM role

In your AWS account, create an IAM role with the trust policy below. Replace `<deployment-aws-account-id>` with the AWS account ID of the Mergecrew deployment you're connecting to (your operator can confirm this — for a self-hosted deployment, it's your own account).

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<deployment-aws-account-id>:root" },
      "Action": "sts:AssumeRole",
      "Condition": {
        "StringEquals": {
          "sts:ExternalId": "<paste-from-settings-page>"
        }
      }
    }
  ]
}
```

The `awsExternalId` value comes from **Settings → Runner → BYO Fargate (your account)** in the Mergecrew UI. It's generated once per org and never rotates, so a stable trust policy works forever.

### 2. Attach minimum permissions

The role needs only what's required to launch + monitor one ECS task at a time:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "ecs:RunTask",
        "ecs:DescribeTasks",
        "ecs:StopTask"
      ],
      "Resource": "*"
    },
    {
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": [
        "<execution-role-arn>",
        "<task-role-arn>"
      ],
      "Condition": {
        "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" }
      }
    },
    {
      "Effect": "Allow",
      "Action": [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:GetLogEvents"
      ],
      "Resource": "arn:aws:logs:*:*:log-group:/ecs/mergecrew-runner:*"
    }
  ]
}
```

Replace `<execution-role-arn>` and `<task-role-arn>` with the ARNs of the IAM roles your ECS task definition references. The `iam:PassRole` condition restricts the role to passing only those roles to ECS — without that condition, the role could pass arbitrary IAM roles to other services.

### 3. Prepare an ECS task definition

Your task definition references the container image Mergecrew launches per run. The deployment doesn't push the image — you stand it up in your own ECR (or pull from `ghcr.io/mergecrew/runner-agent`). A minimal task definition:

- Launch type: Fargate.
- Network mode: `awsvpc` (Fargate requirement).
- CPU + memory sized for your build.
- Container image: `ghcr.io/mergecrew/runner-agent:latest` (or your fork).
- Logs configured to a log group your role above can write to.

The task definition ARN goes into **Settings → Runner → Task definition ARN**.

### 4. Network setup

- **Subnets**: comma-separated list. ECS launches tasks in these subnets.
- **Security groups**: comma-separated, optional. If empty, ECS uses the default SG for the subnet's VPC. The SG only needs **outbound** HTTPS to the deployment's API URL — no inbound rules.

### 5. Save the profile

Settings → Runner → BYO Fargate (your account) → fill all required fields → Save. The API validates that `awsRoleArn` is present; subnets are recommended but not strictly required at PATCH time (the dispatcher will enforce them at run time when #786 lands).

## Cost + isolation guarantees

- The deployment never holds long-lived AWS credentials for your account. Every dispatch performs `sts:AssumeRole` with the external-ID gate; AssumeRole-issued credentials are short-lived (1 hour default).
- Compute billing lands in your AWS account.
- The deployment account only sees: role ARN, region, cluster/task names, subnet IDs, SG IDs. None are secrets on their own.

## Verifying the configuration ahead of #786

You can dry-run the trust relationship today with the AWS CLI from the deployment's environment:

```sh
aws sts assume-role \
  --role-arn arn:aws:iam::<your-account>:role/mergecrew-runner \
  --role-session-name mergecrew-verify \
  --external-id <paste-from-settings-page>
```

This should return temporary credentials. If it errors with "Access Denied" or "ExternalId required" you know the trust policy is wrong; fix it before #786 ships and you'll be running on day one.

## Troubleshooting (post-#786, forward-looking)

- **`AssumeRole failed: trust policy missing externalId`** — your trust policy doesn't have the `sts:ExternalId` condition. Re-paste from the UI.
- **`AssumeRole failed: not authorized to perform sts:AssumeRole`** — your role's trust policy doesn't list the deployment's account ID as a principal.
- **`RunTask failed: no eligible instances`** — your subnets are in an AZ Fargate doesn't support, or you've hit your account-level Fargate vCPU quota.

## Related
- [ADR-0002](../adrs/0002-per-org-runner-profile.md) — per-org runner profile.
- [ADR-0007](../adrs/0007-byo-cloud-credentials.md) — STS role assumption; no stored AWS keys.
- [#786](https://github.com/mergecrew/mergecrew/issues/786) — dispatcher + executor.
- [16-self-host-runbook.md § BYO runner agent](16-self-host-runbook.md#byo-runner-agent) — alternative BYO path.
