data "aws_caller_identity" "current" {}

locals {
  ecr_registry = "${data.aws_caller_identity.current.account_id}.dkr.ecr.${var.region}.amazonaws.com"

  # Container env (plain) and secrets blocks reused by every task definition.
  # Built once here so the for_each over services stays compact.
  container_env_kv = [
    for k, v in local.base_env : { name = k, value = v }
  ]
  container_secrets_kv = [
    for k, arn in var.secrets : { name = k, valueFrom = arn }
  ]
}

resource "aws_ecs_task_definition" "service" {
  for_each = local.services

  family                   = "${local.name_prefix}-${each.key}"
  cpu                      = each.value.cpu
  memory                   = each.value.memory
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.task[each.key].arn

  # Larger ephemeral storage for the runner (repo clones, builds).
  dynamic "ephemeral_storage" {
    for_each = each.value.ephemeral_gib > 21 ? [each.value.ephemeral_gib] : []
    content {
      size_in_gib = ephemeral_storage.value
    }
  }

  container_definitions = jsonencode([
    {
      name      = each.key
      image     = "${aws_ecr_repository.service[each.key].repository_url}:${var.image_tag}"
      essential = true

      portMappings = each.value.container_port > 0 ? [
        {
          containerPort = each.value.container_port
          protocol      = "tcp"
        },
      ] : []

      environment = local.container_env_kv
      secrets     = local.container_secrets_kv

      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service[each.key].name
          awslogs-region        = var.region
          awslogs-stream-prefix = "ecs"
        }
      }

      command = each.value.command
    },
  ])
}

resource "aws_ecs_service" "service" {
  for_each = local.services

  name            = "${local.name_prefix}-${each.key}"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.service[each.key].arn
  desired_count   = each.value.desired_count
  launch_type     = "FARGATE"

  # Tasks live in private subnets; no public IPs.
  network_configuration {
    subnets          = var.private_subnet_ids
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }

  # Only the api service is registered with the ALB.
  dynamic "load_balancer" {
    for_each = each.value.expose_alb ? [1] : []
    content {
      target_group_arn = aws_lb_target_group.api.arn
      container_name   = each.key
      container_port   = each.value.container_port
    }
  }

  deployment_minimum_healthy_percent = 50
  deployment_maximum_percent         = 200

  # Outside the deploy workflow, image_tag is the only thing that should drift.
  # Ignore desired_count too, so a manual scale-up from the console isn't
  # immediately reverted by `terraform apply`.
  lifecycle {
    ignore_changes = [desired_count]
  }

  # Wait for *some* listener to exist before the api service registers with
  # the target group, otherwise the first deploy can race the listener.
  depends_on = [
    aws_lb_listener.http_forward,
    aws_lb_listener.http_redirect,
    aws_lb_listener.https,
  ]
}
