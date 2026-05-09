alter table "schedules"
  add column if not exists "skip_dates" text[] not null default array[]::text[];
