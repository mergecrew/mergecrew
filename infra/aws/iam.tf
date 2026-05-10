# ─── Task execution role ────────────────────────────────────────────────────
# Pulls images from ECR and reads secrets from Secrets Manager so they can be
# injected as container environment variables.

data "aws_iam_policy_document" "ecs_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "task_execution" {
  name               = "${local.name_prefix}-task-execution"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}

resource "aws_iam_role_policy_attachment" "task_execution_managed" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# Permission to read the secret values listed in `var.secrets`. We grant only
# the ARNs the caller passed in — no wildcard secret access.
data "aws_iam_policy_document" "task_execution_secrets" {
  count = length(var.secrets) > 0 ? 1 : 0

  statement {
    sid       = "ReadInjectedSecrets"
    effect    = "Allow"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = values(var.secrets)
  }
}

resource "aws_iam_role_policy" "task_execution_secrets" {
  count  = length(var.secrets) > 0 ? 1 : 0
  name   = "${local.name_prefix}-task-execution-secrets"
  role   = aws_iam_role.task_execution.id
  policy = data.aws_iam_policy_document.task_execution_secrets[0].json
}

# ─── Per-service task role ──────────────────────────────────────────────────
# The role the *application* runs as. We create one per service so future
# scoping (e.g. only the runner can write to S3 artifacts) is a matter of
# attaching policies to the right role rather than changing the trust model.

resource "aws_iam_role" "task" {
  for_each           = local.services
  name               = "${local.name_prefix}-${each.key}-task"
  assume_role_policy = data.aws_iam_policy_document.ecs_assume.json
}
