# Public ALB → API service. Only the api service is exposed publicly.
# The other services receive work via Redis/Postgres queues.

resource "aws_lb" "api" {
  name               = "${local.name_prefix}-api"
  load_balancer_type = "application"
  internal           = false
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]

  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "api" {
  name        = "${local.name_prefix}-api"
  port        = local.services.api.container_port
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"

  # The Nest API has no public `/` health endpoint (admin-scoped only); a
  # 404 from a healthy container is fine — accept any non-5xx.
  health_check {
    path                = "/"
    matcher             = "200-499"
    interval            = 30
    timeout             = 10
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }

  deregistration_delay = 30
}

# HTTP listener.
# - When HTTPS is enabled, redirect to HTTPS.
# - Otherwise, forward to the API (so plain `http://<alb-dns>` works for
#   bring-up before a domain/cert exists).
resource "aws_lb_listener" "http_redirect" {
  count = local.enable_https ? 1 : 0

  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type = "redirect"
    redirect {
      port        = "443"
      protocol    = "HTTPS"
      status_code = "HTTP_301"
    }
  }
}

resource "aws_lb_listener" "http_forward" {
  count = local.enable_https ? 0 : 1

  load_balancer_arn = aws_lb.api.arn
  port              = 80
  protocol          = "HTTP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_lb_listener" "https" {
  count = local.enable_https ? 1 : 0

  load_balancer_arn = aws_lb.api.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_certificate_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}
