-- MFA TOTP storage. All columns nullable so existing users land in the
-- "not enrolled" state. Secrets are envelope-encrypted via CryptoService.

alter table "users"
  add column if not exists "mfa_secret_ciphertext" bytea,
  add column if not exists "mfa_pending_ciphertext" bytea,
  add column if not exists "mfa_enrolled_at" timestamptz(6);
