alter table "projects" add column if not exists "last_digest_at" timestamptz(6);
