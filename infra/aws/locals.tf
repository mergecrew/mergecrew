locals {
  name_prefix = "mergecrew-${var.environment}"

  # ─── Service definitions ─────────────────────────────────────────────────
  # One entry per long-running container. The ALB attaches only to services
  # with `expose_alb = true` (currently just the API).
  #
  # cpu / memory are Fargate task sizes — see
  # https://docs.aws.amazon.com/AmazonECS/latest/developerguide/task-cpu-memory-error.html
  # for valid combinations.
  services = {
    api = {
      cpu              = "1024"
      memory           = "2048"
      desired_count    = 2
      container_port   = 4000
      expose_alb       = true
      ephemeral_gib    = 21 # default
      command          = null
    }
    orchestrator = {
      cpu              = "512"
      memory           = "1024"
      desired_count    = 2
      container_port   = 0
      expose_alb       = false
      ephemeral_gib    = 21
      command          = null
    }
    runner = {
      cpu              = "2048"
      memory           = "8192"
      desired_count    = 4
      container_port   = 0
      expose_alb       = false
      # Runner needs scratch space for repo clones + builds.
      ephemeral_gib    = 50
      command          = null
    }
    "worker-cron" = {
      cpu              = "256"
      memory           = "512"
      desired_count    = 1
      container_port   = 0
      expose_alb       = false
      ephemeral_gib    = 21
      command          = null
    }
  }

  # Plain env vars merged into every container. The deploy workflow may add
  # service-specific extras at apply time via `var.extra_env`.
  base_env = merge(
    {
      AWS_REGION = var.region
    },
    var.extra_env,
  )

  enable_https = var.api_domain != "" && var.acm_certificate_arn != ""
  enable_oidc  = var.github_repo != ""
}
