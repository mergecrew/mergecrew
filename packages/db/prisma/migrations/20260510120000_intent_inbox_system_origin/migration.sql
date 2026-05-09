-- Allow system-originated intents (Sentry webhook, etc.) to skip the
-- submitted_by_user_id FK and add a source_key for cross-source dedup.

alter table "intent_inbox_items"
  alter column "submitted_by_user_id" drop not null;

alter table "intent_inbox_items"
  add column if not exists "source_key" text;

create index if not exists "intent_inbox_items_project_id_source_key_created_at_idx"
  on "intent_inbox_items" ("project_id", "source_key", "created_at");
