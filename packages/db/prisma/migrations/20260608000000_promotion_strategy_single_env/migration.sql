-- Add `single_env` to the promotion strategy kind enum (#478). For
-- projects without a separate prod environment yet (pre-launch /
-- early-stage), dev IS prod — the daily digest is purely a review
-- gate. Promote with this kind runs no git operations.

do $$ begin
  if not exists (
    select 1 from pg_enum
    where enumlabel = 'single_env'
      and enumtypid = (select oid from pg_type where typname = 'promotion_strategy_kind')
  ) then
    alter type "promotion_strategy_kind" add value 'single_env';
  end if;
end $$;
