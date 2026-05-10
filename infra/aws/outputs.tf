output "alb_dns_name" {
  description = "Public DNS of the API load balancer. Point your Route 53 record at this when using a custom api_domain."
  value       = aws_lb.api.dns_name
}

output "alb_zone_id" {
  description = "Hosted-zone ID of the ALB (for Route 53 alias records)."
  value       = aws_lb.api.zone_id
}

output "ecs_cluster_name" {
  description = "Name of the ECS cluster — used by the deploy workflow."
  value       = aws_ecs_cluster.main.name
}

output "ecr_repository_urls" {
  description = "Map of service → ECR repository URL. The deploy workflow tags + pushes to these."
  value       = { for k, r in aws_ecr_repository.service : k => r.repository_url }
}

output "service_names" {
  description = "Map of service key → ECS service name. The deploy workflow calls `aws ecs update-service` against these."
  value       = { for k, s in aws_ecs_service.service : k => s.name }
}

output "github_deploy_role_arn" {
  description = "ARN of the IAM role the GitHub deploy workflow assumes via OIDC. Empty if `github_repo` was not set."
  value       = local.enable_oidc ? aws_iam_role.github_deploy[0].arn : ""
}

output "task_execution_role_arn" {
  description = "ARN of the ECS task execution role."
  value       = aws_iam_role.task_execution.arn
}

output "task_role_arns" {
  description = "Map of service → task role ARN. Useful when attaching extra policies (e.g. S3 access for the runner)."
  value       = { for k, r in aws_iam_role.task : k => r.arn }
}
