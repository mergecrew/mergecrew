-- One row per active recovery code, keyed by sha256 hash. Consuming a
-- code deletes the row so the count is always accurate.

create table if not exists "user_mfa_recovery_codes" (
  "id" uuid not null,
  "user_id" uuid not null,
  "code_hash" text not null,
  "created_at" timestamp(6) with time zone not null default current_timestamp,
  constraint "user_mfa_recovery_codes_pkey" primary key ("id")
);

create unique index if not exists "user_mfa_recovery_codes_code_hash_key"
  on "user_mfa_recovery_codes" ("code_hash");

create index if not exists "user_mfa_recovery_codes_user_id_idx"
  on "user_mfa_recovery_codes" ("user_id");

alter table "user_mfa_recovery_codes"
  add constraint "user_mfa_recovery_codes_user_id_fkey"
  foreign key ("user_id") references "users" ("id") on delete cascade on update cascade;
