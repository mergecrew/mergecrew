-- Nightly eval cron opt-in (V2.ab #303). Off by default — each run
-- costs a few dollars at typical profile pricing. Operators flip it
-- on under Settings → Evals.

ALTER TABLE "organizations"
  ADD COLUMN "evals_enabled" BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN "evals_last_ran_at" TIMESTAMPTZ(6);
