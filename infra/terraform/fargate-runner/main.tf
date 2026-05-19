// Fargate runner module (#578).
//
// Provisions:
//   - ECS cluster (or reuses one passed via var.cluster_name).
//   - Task definition for the mergecrew runner sandbox: vCPU/memory,
//     image, IAM execution + task roles, awsVpcConfiguration hook,
//     enableExecuteCommand for ECS Execute Command.
//   - Security group locking egress to allowlisted CIDRs only — the
//     sandbox cannot reach VPC peers, RDS, etc.
//   - CloudWatch log group for task stdout/stderr.
//
// The supervisor (Helm-deployed or EC2-deployed) consumes the outputs
// via RUNNER_FARGATE_* env vars (see docs/03-infrastructure/26-runner-fargate.md).

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "name" {
  description = "Resource prefix used for the ECS cluster, task definition and IAM roles."
  type        = string
  default     = "mergecrew-runner"
}

variable "vpc_id" {
  description = "VPC the sandbox tasks run in."
  type        = string
}

variable "private_subnet_ids" {
  description = "Private subnets the sandbox task ENIs land on. Must have outbound via NAT or VPC endpoints."
  type        = list(string)
}

variable "sandbox_image" {
  description = "Default container image (must include the SSM agent — see docs)."
  type        = string
  default     = "ghcr.io/mergecrew/runner-polyglot:latest"
}

variable "task_cpu" {
  description = "vCPU units for the task (256, 512, 1024, 2048, 4096)."
  type        = number
  default     = 1024
}

variable "task_memory" {
  description = "Memory MB for the task (must match Fargate vCPU/memory matrix)."
  type        = number
  default     = 2048
}

variable "egress_cidrs" {
  description = "Allowlisted CIDRs the sandbox security group permits outbound."
  type        = list(string)
  default     = []
}

variable "cluster_name" {
  description = "If set, reuse an existing ECS cluster instead of creating one."
  type        = string
  default     = ""
}

locals {
  create_cluster = var.cluster_name == ""
  cluster_name   = local.create_cluster ? aws_ecs_cluster.this[0].name : var.cluster_name
}

resource "aws_ecs_cluster" "this" {
  count = local.create_cluster ? 1 : 0
  name  = var.name

  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "this" {
  name              = "/ecs/${var.name}"
  retention_in_days = 30
}

resource "aws_iam_role" "execution" {
  name = "${var.name}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "execution_ecs" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name = "${var.name}-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
}

// Task role gets *only* what ECS Execute Command needs. No KMS / no
// SecretsManager — the supervisor mediates any credential the sandbox
// would otherwise need (#554 threat T-5).
resource "aws_iam_role_policy" "task_execute_command" {
  name = "${var.name}-execute-command"
  role = aws_iam_role.task.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "ssmmessages:CreateControlChannel",
        "ssmmessages:CreateDataChannel",
        "ssmmessages:OpenControlChannel",
        "ssmmessages:OpenDataChannel",
        "logs:CreateLogStream",
        "logs:DescribeLogStreams",
        "logs:PutLogEvents"
      ]
      Resource = "*"
    }]
  })
}

resource "aws_security_group" "sandbox" {
  name        = "${var.name}-sandbox"
  description = "Mergecrew Fargate sandbox tasks — restricted egress."
  vpc_id      = var.vpc_id

  // Egress: open only to the allowlisted CIDRs. Empty default ⇒ no
  // outbound at all (V0 default-deny).
  dynamic "egress" {
    for_each = var.egress_cidrs
    content {
      from_port   = 443
      to_port     = 443
      protocol    = "tcp"
      cidr_blocks = [egress.value]
    }
  }
}

resource "aws_ecs_task_definition" "this" {
  family                   = var.name
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = tostring(var.task_cpu)
  memory                   = tostring(var.task_memory)
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([{
    name      = "sandbox"
    image     = var.sandbox_image
    essential = true
    user      = "1001:1001"
    readonlyRootFilesystem = true
    linuxParameters = {
      initProcessEnabled = true
    }
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = aws_cloudwatch_log_group.this.name
        awslogs-region        = data.aws_region.current.name
        awslogs-stream-prefix = "sandbox"
      }
    }
    mountPoints = [
      { sourceVolume = "workspace", containerPath = "/workspace" },
      { sourceVolume = "tmp",       containerPath = "/tmp" },
      { sourceVolume = "home",      containerPath = "/home/mergecrew" }
    ]
  }])

  volume { name = "workspace" }
  volume { name = "tmp" }
  volume { name = "home" }
}

data "aws_region" "current" {}

output "cluster_name" {
  description = "Pass to the runner as RUNNER_FARGATE_CLUSTER."
  value       = local.cluster_name
}

output "task_definition_family" {
  description = "Pass to the runner as RUNNER_FARGATE_TASK_DEFINITION."
  value       = aws_ecs_task_definition.this.family
}

output "security_group_id" {
  description = "Pass to the runner as RUNNER_FARGATE_SG."
  value       = aws_security_group.sandbox.id
}

output "subnet_ids" {
  description = "Pass to the runner as RUNNER_FARGATE_SUBNETS (comma-separated)."
  value       = var.private_subnet_ids
}
