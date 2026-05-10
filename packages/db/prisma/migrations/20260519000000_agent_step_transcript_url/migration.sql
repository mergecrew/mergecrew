-- Pointer to the agent step's persisted transcript blob (#4).
-- See packages/transcript-store for the writer; the column is just a
-- scheme-prefixed location (s3://bucket/key or file:///path).
alter table "agent_steps"
  add column if not exists "transcript_url" text;
