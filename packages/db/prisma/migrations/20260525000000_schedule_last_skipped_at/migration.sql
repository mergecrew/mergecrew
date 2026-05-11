-- Track the most recent tick that would have fired but was skipped
-- (paused project, etc.) so the UI can tell the operator "your cron
-- ran but nothing happened, and here's the timestamp." See #246.
ALTER TABLE "schedules"
  ADD COLUMN "last_skipped_at" TIMESTAMPTZ(6);
