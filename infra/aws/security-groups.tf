# Two SGs:
#   - `alb`   accepts 80/443 from the internet
#   - `tasks` accepts traffic only from the ALB SG (and from itself, so the
#             services can talk to each other on private ports)
#
# Outbound is open in both, since the API needs to call upstreams (LLMs,
# GitHub, etc.) and the runner needs to clone repositories.

resource "aws_security_group" "alb" {
  name        = "${local.name_prefix}-alb"
  description = "Public ALB for the API"
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "alb_http_in" {
  type              = "ingress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  ipv6_cidr_blocks  = ["::/0"]
  security_group_id = aws_security_group.alb.id
  description       = "HTTP (redirected to HTTPS when api_domain is set)"
}

resource "aws_security_group_rule" "alb_https_in" {
  count = local.enable_https ? 1 : 0

  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  cidr_blocks       = ["0.0.0.0/0"]
  ipv6_cidr_blocks  = ["::/0"]
  security_group_id = aws_security_group.alb.id
  description       = "HTTPS"
}

resource "aws_security_group_rule" "alb_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.alb.id
  description       = "All outbound (to tasks)"
}

resource "aws_security_group" "tasks" {
  name        = "${local.name_prefix}-tasks"
  description = "Fargate tasks for ${local.name_prefix}"
  vpc_id      = var.vpc_id
}

resource "aws_security_group_rule" "tasks_from_alb" {
  type                     = "ingress"
  from_port                = 0
  to_port                  = 65535
  protocol                 = "tcp"
  source_security_group_id = aws_security_group.alb.id
  security_group_id        = aws_security_group.tasks.id
  description              = "From ALB"
}

resource "aws_security_group_rule" "tasks_self" {
  type              = "ingress"
  from_port         = 0
  to_port           = 65535
  protocol          = "tcp"
  self              = true
  security_group_id = aws_security_group.tasks.id
  description       = "Service-to-service"
}

resource "aws_security_group_rule" "tasks_egress" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  cidr_blocks       = ["0.0.0.0/0"]
  security_group_id = aws_security_group.tasks.id
  description       = "All outbound (LLM upstreams, GitHub, etc.)"
}
