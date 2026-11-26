-- Auth hardening: TOTP replay protection, per-user MFA attempt lockout,
-- and a per-user session token version used for server-side session
-- revocation on sign-out. All columns are additive with safe defaults,
-- so existing rows need no backfill and existing sessions (which carry
-- no `tv` claim, treated as version 0) keep working until sign-out.

alter table "users"
  add column "mfa_last_used_step" integer,
  add column "mfa_failed_attempts" integer not null default 0,
  add column "mfa_locked_until" timestamptz(6),
  add column "token_version" integer not null default 0;

-- Re-enrolling an already-enrolled user now requires a current code at
-- /mfa/setup. Drop any pending secret that was staged on an enrolled
-- account under the old rules so it cannot be promoted by /mfa/verify.
update "users"
   set "mfa_pending_ciphertext" = null
 where "mfa_enrolled_at" is not null
   and "mfa_pending_ciphertext" is not null;

-- Pending org invitations. Inviting by email no longer adds an existing
-- account directly (and no longer reveals whether one exists): a row is
-- created here and the invitee accepts it after signing in.
create table "org_invitations" (
  "id"                 uuid           primary key default gen_random_uuid(),
  "organization_id"    uuid           not null,
  "email"              text           not null,
  "role"               "org_role"     not null,
  "invited_by_user_id" uuid,
  "created_at"         timestamptz(6) not null default now(),
  "expires_at"         timestamptz(6) not null,
  constraint "org_invitations_organization_id_fkey"
    foreign key ("organization_id") references "organizations"("id") on delete cascade on update cascade
);

create unique index "org_invitations_organization_id_email_key"
  on "org_invitations" ("organization_id", "email");
create index "org_invitations_email_idx" on "org_invitations" ("email");

alter table "org_invitations" enable row level security;
alter table "org_invitations" force row level security;

create policy "tenant_isolation" on "org_invitations"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);
