-- Grant mergecrew_migrator table-level privs (#806 / #819 followup).
--
-- The original RLS migration (20260508000001_rls) grants
-- mergecrew_app SELECT/INSERT/UPDATE/DELETE on every existing +
-- future table in `public`, but skipped mergecrew_migrator. That
-- was fine while the seed used the runtime PrismaClient (which
-- connects as the table owner / superuser in dev compose). Prisma
-- 7 (#806) switched seed.ts to construct its own client against
-- the migrator URL so it can do cross-tenant inserts without
-- toggling `set_config('app.org_id')` per call — the migrator
-- role bypasses RLS by design.
--
-- Net effect: with the migrator URL set, every cross-tenant write
-- by the seed (price table, demo org, demo user, demo project)
-- hits `permission denied for table …`.
--
-- Symmetric to the mergecrew_app block — same idempotent-safe
-- DO-block pattern; no-op when the role isn't provisioned (e.g.
-- prod IaC that names the role differently).
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'mergecrew_migrator') then
    grant select, insert, update, delete on all tables in schema public to mergecrew_migrator;
    grant usage, select on all sequences in schema public to mergecrew_migrator;
    alter default privileges in schema public
      grant select, insert, update, delete on tables to mergecrew_migrator;
    alter default privileges in schema public
      grant usage, select on sequences to mergecrew_migrator;
  end if;
end $$;
