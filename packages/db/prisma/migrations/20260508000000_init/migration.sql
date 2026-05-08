-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateExtension
CREATE EXTENSION IF NOT EXISTS "vector";

-- CreateEnum
CREATE TYPE "org_role" AS ENUM ('owner', 'admin', 'operator', 'viewer');

-- CreateEnum
CREATE TYPE "deploy_target_kind" AS ENUM ('dev', 'staging', 'prod');

-- CreateEnum
CREATE TYPE "daily_run_status" AS ENUM ('pending', 'running', 'paused_rate_limit', 'paused_gate', 'done', 'failed', 'cancelled');

-- CreateEnum
CREATE TYPE "changeset_status" AS ENUM ('proposed', 'building', 'testing', 'tests_failed', 'flagged', 'pr_open', 'dev_deployed', 'awaiting_decision', 'promoted', 'rolled_back', 'deferred', 'abandoned');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "avatar_url" TEXT,
    "default_org_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "working_hours_start" TEXT NOT NULL DEFAULT '09:00',
    "working_hours_end" TEXT NOT NULL DEFAULT '18:00',
    "default_llm_profile_id" UUID,
    "default_gate_policy_id" UUID,
    "compliance_audit_retention_days" INTEGER NOT NULL DEFAULT 365,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memberships" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" "org_role" NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memberships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log_entries" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "actor_user_id" UUID,
    "action" TEXT NOT NULL,
    "target" JSONB NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "connected_repos" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "vcs_provider" TEXT NOT NULL,
    "installation_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "repo_full_name" TEXT NOT NULL,
    "default_branch" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "connected_repos_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deploy_targets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "kind" "deploy_target_kind" NOT NULL,
    "adapter_id" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deploy_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "project_secrets" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ciphertext" BYTEA NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "project_secrets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_providers" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "endpoint" TEXT,
    "credential_ciphertext" BYTEA,
    "capability_overrides" JSONB,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_providers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_profiles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "preference_order" JSONB NOT NULL,
    "capability_routing" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_price_table" (
    "provider_kind" TEXT NOT NULL,
    "model_id" TEXT NOT NULL,
    "effective_at" TIMESTAMPTZ(6) NOT NULL,
    "input_per_million_usd" DECIMAL(10,6) NOT NULL,
    "output_per_million_usd" DECIMAL(10,6) NOT NULL,
    "cache_read_per_million_usd" DECIMAL(10,6),
    "cache_write_per_million_usd" DECIMAL(10,6),

    CONSTRAINT "model_price_table_pkey" PRIMARY KEY ("provider_kind","model_id","effective_at")
);

-- CreateTable
CREATE TABLE "lifecycles" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "source_yaml" TEXT NOT NULL,
    "parsed" JSONB NOT NULL,
    "active_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "lifecycles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "gate_policies" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID,
    "policy" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "active_from" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gate_policies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "daily_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "lifecycle_id" UUID NOT NULL,
    "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "status" "daily_run_status" NOT NULL DEFAULT 'pending',
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "daily_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "workflow_runs" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "daily_run_id" UUID NOT NULL,
    "workflow_id" TEXT NOT NULL,
    "parent_workflow_run_id" UUID,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "workflow_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_steps" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "workflow_run_id" UUID NOT NULL,
    "agent_kind" TEXT NOT NULL,
    "agent_instance_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "status" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "failure_reason" TEXT,
    "started_at" TIMESTAMPTZ(6),
    "finished_at" TIMESTAMPTZ(6),
    "total_input_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_output_tokens" INTEGER NOT NULL DEFAULT 0,
    "total_usd_estimate" DECIMAL(12,6) NOT NULL DEFAULT 0,

    CONSTRAINT "agent_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tool_calls" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_step_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "skill_name" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "output" JSONB,
    "is_error" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),
    "side_effect_class" TEXT NOT NULL,

    CONSTRAINT "tool_calls_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "model_turns" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "agent_step_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "provider_id" UUID NOT NULL,
    "model_id" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "thinking_tokens" INTEGER,
    "latency_ms" INTEGER NOT NULL,
    "usd_estimate" DECIMAL(12,6) NOT NULL,
    "raw_request_blob_url" TEXT,
    "raw_response_blob_url" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "model_turns_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "llm_invocations" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "run_id" UUID,
    "agent_step_id" UUID,
    "provider_id" UUID NOT NULL,
    "model_id" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL,
    "output_tokens" INTEGER NOT NULL,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "thinking_tokens" INTEGER,
    "latency_ms" INTEGER NOT NULL,
    "usd_estimate" DECIMAL(12,6) NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_invocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "run_pauses" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "daily_run_id" UUID NOT NULL,
    "step_id" UUID,
    "kind" TEXT NOT NULL,
    "provider_id" UUID,
    "approval_request_id" UUID,
    "paused_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wake_at" TIMESTAMPTZ(6),
    "resumed_at" TIMESTAMPTZ(6),

    CONSTRAINT "run_pauses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "changesets" (
    "id" TEXT NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "daily_run_id" UUID NOT NULL,
    "workflow_run_id" UUID,
    "title" TEXT NOT NULL,
    "why_paragraph" TEXT,
    "branch" TEXT NOT NULL,
    "status" "changeset_status" NOT NULL DEFAULT 'proposed',
    "pr_number" INTEGER,
    "pr_url" TEXT,
    "dev_deploy_id" UUID,
    "test_summary" JSONB,
    "risk_chip" TEXT,
    "estimated_usd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "changesets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deploys" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "changeset_id" TEXT,
    "deploy_target_id" UUID NOT NULL,
    "ref" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "external_run_id" TEXT,
    "url" TEXT,
    "status" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(6) NOT NULL,
    "finished_at" TIMESTAMPTZ(6),

    CONSTRAINT "deploys_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "changeset_id" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "comment" TEXT,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "approval_requests" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "workflow_run_id" UUID NOT NULL,
    "changeset_id" TEXT,
    "reason" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "required_role" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(6),
    "resolved_by_user_id" UUID,
    "resolution" TEXT,

    CONSTRAINT "approval_requests_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "intent_inbox_items" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "submitted_by_user_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "picked_up_run_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "intent_inbox_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "schedules" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "cron" TEXT NOT NULL DEFAULT '0 8 * * 1-5',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "last_fired_at" TIMESTAMPTZ(6),
    "next_fire_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "schedules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timeline_events" (
    "id" BIGSERIAL NOT NULL,
    "event_id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "daily_run_id" UUID,
    "workflow_run_id" UUID,
    "agent_step_id" UUID,
    "changeset_id" TEXT,
    "parent_event_id" UUID,
    "type" TEXT NOT NULL,
    "actor" JSONB NOT NULL,
    "payload" JSONB NOT NULL,
    "occurred_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "timeline_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_documents" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "collection" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_accounts" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "auth_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_sessions" (
    "id" UUID NOT NULL,
    "session_token" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "expires" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "auth_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "auth_verification_tokens" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMPTZ(6) NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "memberships_organization_id_user_id_key" ON "memberships"("organization_id", "user_id");

-- CreateIndex
CREATE INDEX "audit_log_entries_organization_id_occurred_at_idx" ON "audit_log_entries"("organization_id", "occurred_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "projects_organization_id_slug_key" ON "projects"("organization_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "connected_repos_project_id_key" ON "connected_repos"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "deploy_targets_project_id_kind_key" ON "deploy_targets"("project_id", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "project_secrets_project_id_name_key" ON "project_secrets"("project_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "llm_profiles_organization_id_name_key" ON "llm_profiles"("organization_id", "name");

-- CreateIndex
CREATE UNIQUE INDEX "lifecycles_project_id_version_key" ON "lifecycles"("project_id", "version");

-- CreateIndex
CREATE INDEX "daily_runs_project_id_scheduled_at_idx" ON "daily_runs"("project_id", "scheduled_at" DESC);

-- CreateIndex
CREATE INDEX "agent_steps_status_started_at_idx" ON "agent_steps"("status", "started_at");

-- CreateIndex
CREATE UNIQUE INDEX "tool_calls_agent_step_id_sequence_key" ON "tool_calls"("agent_step_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "model_turns_agent_step_id_sequence_key" ON "model_turns"("agent_step_id", "sequence");

-- CreateIndex
CREATE INDEX "llm_invocations_organization_id_occurred_at_idx" ON "llm_invocations"("organization_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "llm_invocations_project_id_occurred_at_idx" ON "llm_invocations"("project_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "run_pauses_wake_at_idx" ON "run_pauses"("wake_at");

-- CreateIndex
CREATE INDEX "changesets_project_id_status_updated_at_idx" ON "changesets"("project_id", "status", "updated_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "deploys_project_id_correlation_id_key" ON "deploys"("project_id", "correlation_id");

-- CreateIndex
CREATE INDEX "approval_requests_project_id_resolved_at_idx" ON "approval_requests"("project_id", "resolved_at");

-- CreateIndex
CREATE INDEX "intent_inbox_items_project_id_status_created_at_idx" ON "intent_inbox_items"("project_id", "status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "schedules_project_id_key" ON "schedules"("project_id");

-- CreateIndex
CREATE INDEX "schedules_next_fire_at_idx" ON "schedules"("next_fire_at");

-- CreateIndex
CREATE UNIQUE INDEX "timeline_events_event_id_key" ON "timeline_events"("event_id");

-- CreateIndex
CREATE INDEX "timeline_events_daily_run_id_occurred_at_idx" ON "timeline_events"("daily_run_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "timeline_events_project_id_occurred_at_idx" ON "timeline_events"("project_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "memory_documents_project_id_collection_idx" ON "memory_documents"("project_id", "collection");

-- CreateIndex
CREATE UNIQUE INDEX "auth_accounts_provider_provider_account_id_key" ON "auth_accounts"("provider", "provider_account_id");

-- CreateIndex
CREATE UNIQUE INDEX "auth_sessions_session_token_key" ON "auth_sessions"("session_token");

-- CreateIndex
CREATE UNIQUE INDEX "auth_verification_tokens_token_key" ON "auth_verification_tokens"("token");

-- CreateIndex
CREATE UNIQUE INDEX "auth_verification_tokens_identifier_token_key" ON "auth_verification_tokens"("identifier", "token");

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log_entries" ADD CONSTRAINT "audit_log_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "connected_repos" ADD CONSTRAINT "connected_repos_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploy_targets" ADD CONSTRAINT "deploy_targets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "project_secrets" ADD CONSTRAINT "project_secrets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_providers" ADD CONSTRAINT "llm_providers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_profiles" ADD CONSTRAINT "llm_profiles_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lifecycles" ADD CONSTRAINT "lifecycles_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gate_policies" ADD CONSTRAINT "gate_policies_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_runs" ADD CONSTRAINT "daily_runs_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "daily_runs" ADD CONSTRAINT "daily_runs_lifecycle_id_fkey" FOREIGN KEY ("lifecycle_id") REFERENCES "lifecycles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_daily_run_id_fkey" FOREIGN KEY ("daily_run_id") REFERENCES "daily_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_parent_workflow_run_id_fkey" FOREIGN KEY ("parent_workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tool_calls" ADD CONSTRAINT "tool_calls_agent_step_id_fkey" FOREIGN KEY ("agent_step_id") REFERENCES "agent_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_turns" ADD CONSTRAINT "model_turns_agent_step_id_fkey" FOREIGN KEY ("agent_step_id") REFERENCES "agent_steps"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "model_turns" ADD CONSTRAINT "model_turns_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "llm_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "llm_invocations" ADD CONSTRAINT "llm_invocations_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "llm_providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_pauses" ADD CONSTRAINT "run_pauses_daily_run_id_fkey" FOREIGN KEY ("daily_run_id") REFERENCES "daily_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "run_pauses" ADD CONSTRAINT "run_pauses_step_id_fkey" FOREIGN KEY ("step_id") REFERENCES "agent_steps"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_daily_run_id_fkey" FOREIGN KEY ("daily_run_id") REFERENCES "daily_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "changesets" ADD CONSTRAINT "changesets_workflow_run_id_fkey" FOREIGN KEY ("workflow_run_id") REFERENCES "workflow_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_changeset_id_fkey" FOREIGN KEY ("changeset_id") REFERENCES "changesets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deploys" ADD CONSTRAINT "deploys_deploy_target_id_fkey" FOREIGN KEY ("deploy_target_id") REFERENCES "deploy_targets"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_changeset_id_fkey" FOREIGN KEY ("changeset_id") REFERENCES "changesets"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_changeset_id_fkey" FOREIGN KEY ("changeset_id") REFERENCES "changesets"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_resolved_by_user_id_fkey" FOREIGN KEY ("resolved_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intent_inbox_items" ADD CONSTRAINT "intent_inbox_items_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intent_inbox_items" ADD CONSTRAINT "intent_inbox_items_submitted_by_user_id_fkey" FOREIGN KEY ("submitted_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "intent_inbox_items" ADD CONSTRAINT "intent_inbox_items_picked_up_run_id_fkey" FOREIGN KEY ("picked_up_run_id") REFERENCES "daily_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "schedules" ADD CONSTRAINT "schedules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
