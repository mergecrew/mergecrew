# AWS deployment

Mergecrew runs on AWS in production. This directory holds Terraform/CDK
sketches for the infrastructure described in `docs/03-infrastructure/`.

## Topology (V1)

- **VPC.** 3 AZs, private subnets for everything except the ALB.
- **ECS Fargate cluster** with services:
  - `mergecrew-api` (2 tasks, 1 vCPU / 2 GB)
  - `mergecrew-orchestrator` (2 tasks, leader-elected via Postgres advisory lock)
  - `mergecrew-runner-pool` (4–20 tasks, 2 vCPU / 8 GB / 20 GB ephemeral)
  - `mergecrew-worker-cron` (1 task)
- **RDS Aurora PostgreSQL 16** with pgvector + multi-AZ writer/reader.
- **ElastiCache Redis** primary + replica.
- **S3** buckets: `mergecrew-prod-artifacts`, `mergecrew-prod-uploads`.
- **KMS** CMK for envelope encryption (BYOK keys, project secrets, GitHub
  App private key, audit log).
- **Route 53 + ACM** for `app.mergecrew.<domain>` (Vercel CNAME) and
  `api.mergecrew.<domain>` (ALB).

## Sketch (Terraform-ish, not yet wired)

```hcl
# infra/aws/main.tf — placeholder
module "vpc" {
  source = "terraform-aws-modules/vpc/aws"
  name   = "mergecrew-${var.environment}"
  cidr   = "10.0.0.0/16"
  azs    = ["us-east-1a", "us-east-1b", "us-east-1c"]
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]
  enable_nat_gateway = true
  one_nat_gateway_per_az = true
}

resource "aws_kms_key" "mergecrew" {
  description         = "Mergecrew envelope encryption"
  enable_key_rotation = true
}

resource "aws_rds_cluster" "mergecrew" {
  engine                = "aurora-postgresql"
  engine_version        = "16.4"
  database_name         = "mergecrew"
  master_username       = "mergecrew_migrator"
  master_password       = var.master_password
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.mergecrew.arn
  enabled_cloudwatch_logs_exports = ["postgresql"]
}

resource "aws_elasticache_replication_group" "mergecrew" {
  replication_group_id          = "mergecrew-${var.environment}"
  description                   = "Mergecrew Redis"
  engine                        = "redis"
  num_cache_clusters            = 2
  automatic_failover_enabled    = true
  transit_encryption_enabled    = true
  at_rest_encryption_enabled    = true
}

resource "aws_s3_bucket" "artifacts" {
  bucket = "mergecrew-${var.environment}-artifacts"
}
```

The actual Terraform modules live alongside this README in `aws/` and are
wired up in CI in V1.x. For now, the sketch documents the target shape.

## Environment variables for ECS tasks

Each Fargate task is launched with the following env vars (sourced from
SSM Parameter Store + Secrets Manager):

```
DATABASE_URL                # Aurora endpoint
REDIS_URL                   # ElastiCache endpoint
JWT_SECRET                  # rotating, KMS-decoded
KMS_MASTER_KEY              # base64; per-env
GITHUB_APP_ID
GITHUB_APP_PRIVATE_KEY
GITHUB_APP_WEBHOOK_SECRET
S3_BUCKET=mergecrew-${env}-artifacts
AWS_REGION=us-east-1
LOG_LEVEL=info
OTEL_EXPORTER_OTLP_ENDPOINT
```

BYOK LLM keys are stored per-tenant in the database (envelope-encrypted)
and never exposed via env.
