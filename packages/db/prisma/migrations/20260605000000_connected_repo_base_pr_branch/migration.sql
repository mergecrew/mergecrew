-- Base PR branch on connected_repos (#469). Decouples "where mergecrew
-- opens PRs" (a choice) from "what the GitHub repo's default branch is"
-- (a fact). For branch-per-env teams (developer → dev, qa → stage,
-- main → prod), the user points this at their integration branch. NULL
-- coalesces to `default_branch` so existing rows keep their old
-- behavior without an explicit backfill.

ALTER TABLE "connected_repos"
  ADD COLUMN "base_pr_branch" TEXT;
