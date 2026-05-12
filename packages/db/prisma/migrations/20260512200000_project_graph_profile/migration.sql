-- Multi-agent graph profile (#336). Default 'fast' so existing
-- projects keep V1 single-agent behavior on upgrade. Operators
-- opt in to 'careful' or 'custom' per project via settings.
alter table projects add column graph_profile text not null default 'fast';
alter table projects add column graph_yaml text;
