-- Bind GitHub App installations to organizations (security fix).
--
-- Before this migration any org could list / connect repositories of any
-- installation of the shared GitHub App by supplying its numeric id, and
-- the runner minted installation tokens for whatever id a connected_repos
-- row carried. `org_github_installations` records which org owns an
-- installation; the API (installation-repos, connect-repo) and the runner
-- (token minting) refuse installation ids without a row for the caller's
-- org.
--
-- RLS-on + forced, same tenant_isolation policy as runner_profiles.
-- Cross-tenant lookups (uniqueness check in the install flow, webhook
-- installation.deleted / suspend handling) go through withSystem().

create table "org_github_installations" (
  "id"                  uuid           primary key default gen_random_uuid(),
  "organization_id"     uuid           not null,
  "installation_id"     text           not null unique,
  "account_login"       text,
  "created_by_user_id"  uuid,
  "suspended_at"        timestamptz(6),
  "created_at"          timestamptz(6) not null default now(),
  "updated_at"          timestamptz(6) not null default now(),
  constraint "org_github_installations_org_fk"
    foreign key ("organization_id") references "organizations" ("id") on delete cascade
);

create index "org_github_installations_organization_id_idx"
  on "org_github_installations" ("organization_id");

alter table "org_github_installations" enable row level security;
alter table "org_github_installations" force row level security;

create policy "tenant_isolation" on "org_github_installations"
  using (organization_id = (current_setting('app.org_id', true))::uuid)
  with check (organization_id = (current_setting('app.org_id', true))::uuid);

-- Backfill. For every installation id already referenced by a GitHub
-- connected_repos row, create a binding only when exactly one org uses
-- it. Installation ids shared by several orgs are ambiguous — there is
-- no way to tell from the database which org legitimately installed the
-- App — so they stay unbound (the API and runner refuse them) and are
-- reported via NOTICE. The owning org re-binds by re-running the
-- GitHub App install flow. Non-numeric placeholder ids ('manual') are
-- skipped: they never resolved to a real installation.
insert into "org_github_installations" ("organization_id", "installation_id")
select (array_agg(distinct cr."organization_id"))[1], cr."installation_id"
from "connected_repos" cr
where cr."vcs_provider" = 'github'
  and cr."installation_id" ~ '^[0-9]+$'
group by cr."installation_id"
having count(distinct cr."organization_id") = 1
on conflict ("installation_id") do nothing;

do $$
declare
  r record;
begin
  for r in
    select cr."installation_id" as installation_id,
           count(distinct cr."organization_id") as org_count
    from "connected_repos" cr
    where cr."vcs_provider" = 'github'
      and cr."installation_id" ~ '^[0-9]+$'
    group by cr."installation_id"
    having count(distinct cr."organization_id") > 1
  loop
    raise notice 'org_github_installations backfill: installation % is referenced by % orgs; left unbound. Re-run the GitHub App install flow from the owning org.',
      r.installation_id, r.org_count;
  end loop;
end $$;
