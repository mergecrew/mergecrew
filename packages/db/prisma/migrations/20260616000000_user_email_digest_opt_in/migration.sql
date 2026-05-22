-- Per-user opt-in for daily digest emails (V2.af / #748).
-- Disabled by default — including for existing users. The prior
-- behavior (broadcast to every org member with an email address) was
-- never an explicit choice, just an absent gate; the right
-- conservative default for a self-hostable OSS install is opt-in,
-- with a single in-app toggle and a one-click unsubscribe link in
-- every email.

alter table "users"
  add column "email_digest_enabled" boolean not null default false;
