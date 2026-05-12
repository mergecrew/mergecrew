-- Multi-agent graph node key (#331). Nullable: existing single-agent
-- runs leave this null and behave exactly as before. Future
-- planner/coder/reviewer graph profiles (#332-#334) populate it.
alter table agent_steps add column graph_node_key text;
