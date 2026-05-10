variable "environment" {
  description = "Environment name (e.g. dev, staging, prod). Used as a suffix on every resource name."
  type        = string
}

variable "region" {
  description = "AWS region for ECS / ECR / ALB."
  type        = string
  default     = "us-east-1"
}

# ─── Network references ──────────────────────────────────────────────────────
# We do NOT provision VPC/subnets here — that's a separate module owned by the
# data-plane layer (or pre-existing in many orgs). Pass IDs in.

variable "vpc_id" {
  description = "VPC for the ECS services + ALB."
  type        = string
}

variable "private_subnet_ids" {
  description = "Subnets the Fargate tasks run in. Should have a NAT gateway for outbound."
  type        = list(string)
}

variable "public_subnet_ids" {
  description = "Subnets the public ALB attaches to."
  type        = list(string)
}

# ─── Data-plane connections ─────────────────────────────────────────────────
# Tasks read these via Secrets Manager; the ARNs of the secrets are passed in
# so the secret rotation / KMS key plumbing stays in the data-plane stack.

variable "secrets" {
  description = "Map of env-var name → Secrets Manager ARN. Values are injected into every task as a `secret`."
  type        = map(string)
  default     = {}
  # Example:
  #   {
  #     DATABASE_URL              = "arn:...:secret:mergecrew/prod/db"
  #     REDIS_URL                 = "arn:...:secret:mergecrew/prod/redis"
  #     JWT_SECRET                = "arn:...:secret:mergecrew/prod/jwt"
  #     KMS_MASTER_KEY            = "arn:...:secret:mergecrew/prod/kms-key"
  #     GITHUB_APP_ID             = "arn:...:secret:mergecrew/prod/github-app-id"
  #     GITHUB_APP_PRIVATE_KEY    = "arn:...:secret:mergecrew/prod/github-app-private-key"
  #     GITHUB_APP_WEBHOOK_SECRET = "arn:...:secret:mergecrew/prod/github-webhook-secret"
  #     SMTP_URL                  = "arn:...:secret:mergecrew/prod/smtp"
  #     BFF_TRUST_TOKEN           = "arn:...:secret:mergecrew/prod/bff-trust"
  #   }
}

variable "extra_env" {
  description = "Plain env vars (NOT secrets) shared by every service. Common: AWS_REGION, LOG_LEVEL, MERGECREW_EMAIL_FROM, OTEL_EXPORTER_OTLP_ENDPOINT, S3 bucket names."
  type        = map(string)
  default = {
    NODE_ENV  = "production"
    LOG_LEVEL = "info"
  }
}

# ─── Domain + TLS for the API ALB ───────────────────────────────────────────

variable "api_domain" {
  description = "Public hostname for the API ALB (e.g. api.mergecrew.example.com). Empty disables HTTPS + Route 53."
  type        = string
  default     = ""
}

variable "acm_certificate_arn" {
  description = "ACM cert ARN for `api_domain`. Required when api_domain is non-empty."
  type        = string
  default     = ""
}

# ─── Image tag — wired by the deploy workflow ────────────────────────────────

variable "image_tag" {
  description = "Tag of the images to run (set by .github/workflows/deploy-services.yml from the merged commit SHA)."
  type        = string
  default     = "latest"
}

# ─── GitHub OIDC for the deploy workflow ────────────────────────────────────

variable "github_repo" {
  description = "owner/repo allowed to assume the deploy role via OIDC. Set to empty to skip the OIDC role."
  type        = string
  default     = ""
}
