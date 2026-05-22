-- Org-level Slack Incoming Webhook (V2.af / #747).
-- One URL per org, encrypted at rest via the same envelope-encryption
-- chokepoint that already protects MFA secrets, LLM API keys, and
-- project secrets. The created-at timestamp gives the UI a "configured
-- N days ago" hint without exposing the URL itself.

alter table "organizations"
  add column "slack_webhook_ciphertext" bytea,
  add column "slack_webhook_created_at" timestamptz(6);
