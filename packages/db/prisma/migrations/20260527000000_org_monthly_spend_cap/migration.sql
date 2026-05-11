-- Hard monthly LLM spend cap per org (#282). NULL = unlimited (default).
-- Enforced at agent-step pre-flight: a run that would push month-to-date
-- past the cap is rejected with reason `cap_exceeded` rather than running
-- and burning the partial spend. Calendar-month boundary uses UTC so the
-- math is independent of org timezone.
ALTER TABLE "organizations"
  ADD COLUMN "monthly_spend_cap_usd" DECIMAL(10, 2);
