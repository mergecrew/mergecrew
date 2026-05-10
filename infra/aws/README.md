# AWS deployment (ECS Fargate)

This Terraform module provisions the **service-plane** for Mergecrew on AWS:
ECS cluster, four Fargate services (api / orchestrator / runner /
worker-cron), the public ALB for the API, ECR repositories, IAM roles,
security groups, log groups, and the GitHub OIDC role used by the deploy
workflow.

What this module deliberately **does not** provision:

- VPC, subnets, NAT gateways
- RDS / Aurora PostgreSQL
- ElastiCache Redis
- S3 buckets
- KMS keys
- Route 53 records / ACM certificates

Those belong to the **data-plane** stack (or already exist in the account)
and are passed in as inputs (`vpc_id`, `private_subnet_ids`, `secrets`,
`acm_certificate_arn`, …). Splitting along this seam keeps the blast radius
of `terraform apply` small — bouncing services should never be one keystroke
away from dropping the database.

## Topology

```
       Internet
          │
          ▼
   ALB (public subnets)
          │ HTTPS → 4000
          ▼
  ┌────────────────────┐
  │  api   (2 tasks)   │── reads ──► RDS Aurora    (data-plane)
  │  orch  (2 tasks)   │── reads ──► ElastiCache   (data-plane)
  │  run   (4 tasks)   │── reads ──► S3 artifacts  (data-plane)
  │  cron  (1 task)    │── reads ──► Secrets Mgr   (data-plane)
  └────────────────────┘
   private subnets · awsvpc · single tasks SG
```

Service sizing (defined in `locals.tf`, override there if you need more):

| service       | cpu   | memory | desired | ephemeral |
|---------------|-------|--------|---------|-----------|
| `api`         | 1024  | 2048   | 2       | 21 GiB    |
| `orchestrator`| 512   | 1024   | 2       | 21 GiB    |
| `runner`      | 2048  | 8192   | 4       | 50 GiB    |
| `worker-cron` | 256   | 512    | 1       | 21 GiB    |

The runner needs the larger ephemeral storage for repo clones and builds.

## Inputs

See `variables.tf` — the required ones are:

- `environment` — e.g. `prod`, `staging`. Suffixed onto every resource name.
- `vpc_id`, `private_subnet_ids`, `public_subnet_ids` — from the data plane.
- `secrets` — map of env-var-name → Secrets Manager ARN. Each entry is
  injected into every task as a `secret`. Typical contents:

  ```hcl
  secrets = {
    DATABASE_URL              = "arn:aws:secretsmanager:us-east-1:…:mergecrew/prod/db"
    REDIS_URL                 = "arn:aws:secretsmanager:us-east-1:…:mergecrew/prod/redis"
    JWT_SECRET                = "arn:aws:secretsmanager:us-east-1:…:mergecrew/prod/jwt"
    KMS_MASTER_KEY            = "arn:aws:secretsmanager:us-east-1:…:mergecrew/prod/kms-key"
    GITHUB_APP_ID             = "arn:aws:secretsmanager:us-east-1:…:mergecrew/prod/github-app-id"
    GITHUB_APP_PRIVATE_KEY    = "arn:aws:secretsmanager:us-east-1:…:mergecrew/prod/github-app-private-key"
    GITHUB_APP_WEBHOOK_SECRET = "arn:aws:secretsmanager:us-east-1:…:mergecrew/prod/github-webhook-secret"
    SMTP_URL                  = "arn:aws:secretsmanager:us-east-1:…:mergecrew/prod/smtp"
    BFF_TRUST_TOKEN           = "arn:aws:secretsmanager:us-east-1:…:mergecrew/prod/bff-trust"
  }
  ```

  The execution role is granted `secretsmanager:GetSecretValue` only for the
  ARNs you pass — no wildcard.
- `extra_env` — plain (non-secret) env vars merged into every task. Defaults
  to `NODE_ENV=production`, `LOG_LEVEL=info`. Add things like
  `OTEL_EXPORTER_OTLP_ENDPOINT`, `S3_BUCKET`, etc.

Optional:

- `api_domain` + `acm_certificate_arn` — when both are set, the ALB gets an
  HTTPS listener and HTTP is 301'd to it. Without them, traffic is
  HTTP-only on `<alb-dns>:80` (fine for bring-up, not for prod).
- `image_tag` — tag of the image each service runs. Defaults to `latest`;
  the deploy workflow overrides it with the commit SHA. Note: services have
  `lifecycle.ignore_changes = [desired_count]` so the deploy can swap images
  without fighting a manual scale.
- `github_repo` — `owner/repo` allowed to assume the deploy role via OIDC.
  Empty disables OIDC entirely (useful for local plans).

## Bring-up

```bash
cd infra/aws
terraform init
terraform plan \
  -var environment=prod \
  -var vpc_id=vpc-xxx \
  -var 'private_subnet_ids=["subnet-aaa","subnet-bbb","subnet-ccc"]' \
  -var 'public_subnet_ids=["subnet-ppp","subnet-qqq","subnet-rrr"]' \
  -var 'secrets={DATABASE_URL="arn:aws:secretsmanager:..."}' \
  -var github_repo=mergecrew/mergecrew

terraform apply
```

After the first apply you'll have empty ECR repos and ECS services that
fail to pull (`latest` doesn't exist yet). That's expected — running the
deploy workflow fills the repos and starts a real deployment.

## Outputs

- `alb_dns_name`, `alb_zone_id` — for the Route 53 alias record.
- `ecs_cluster_name`, `service_names` — used by `deploy-services.yml`.
- `ecr_repository_urls` — map of service → repo URL.
- `github_deploy_role_arn` — paste into `secrets.AWS_DEPLOY_ROLE_ARN`.
- `task_role_arns` — useful if you need to attach extra policies (e.g. S3
  write permissions for the runner).

## Deploy workflow

`.github/workflows/deploy-services.yml` builds + pushes images for the four
services, then forces a new deployment. It only runs when the repo variable
`ECS_DEPLOY_ENABLED == 'true'` (or via manual `workflow_dispatch`), so the
workflow can sit dormant until the Terraform is actually applied.

Required GitHub repo configuration:

| name                       | kind   | source                                |
|----------------------------|--------|---------------------------------------|
| `ECS_DEPLOY_ENABLED`       | var    | set to `true` to enable               |
| `AWS_REGION`               | var    | match the Terraform `region` input    |
| `ECS_CLUSTER_NAME`         | var    | `terraform output ecs_cluster_name`   |
| `ENVIRONMENT`              | var    | `prod` (defaults to `prod` if unset)  |
| `AWS_DEPLOY_ROLE_ARN`      | secret | `terraform output github_deploy_role_arn` |

The workflow:

1. Authenticates to AWS via OIDC (no long-lived keys).
2. Builds each service's Docker image from `infra/docker/Dockerfile.<svc>`
   in parallel. Tags with the 12-char commit SHA + `latest`.
3. Pushes to ECR with GHA build cache.
4. Pulls the live task definition, swaps the image, registers a new
   revision, and `aws ecs update-service --force-new-deployment`. The task
   definition's env vars / secrets / IAM stay owned by Terraform — the
   deploy only changes the image.
5. Waits for `services-stable` so the workflow surfaces drift fast.
