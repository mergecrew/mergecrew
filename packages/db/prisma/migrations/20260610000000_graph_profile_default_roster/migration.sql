-- V2.af (#516): flip the project-level graphProfile default from
-- 'careful' to 'roster' so new projects on a fresh DB run the full
-- Discovery -> PM -> Implementation -> QA -> DeployDev -> Observation
-- lifecycle dispatched via ROSTER_GRAPH.
--
-- Existing rows are not touched: a project that has been running on
-- 'careful' keeps its profile (and `resolveProjectGraph` keeps
-- returning CAREFUL_GRAPH for them). Operators can opt-in to roster
-- per-project via the settings switcher.
ALTER TABLE "projects" ALTER COLUMN "graph_profile" SET DEFAULT 'roster';
