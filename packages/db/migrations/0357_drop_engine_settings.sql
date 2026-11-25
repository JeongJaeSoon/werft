-- Run rules were removed in v0.4.0, which kept these tables with their rows
-- and no longer read or wrote them; v0.3.0's session claim was their last
-- reader.
-- contract: agent_engine_settings last used by v0.3.0
-- contract: workspace_engine_settings last used by v0.3.0
-- Counts only: what the rows held stays out of the log.
DO $$
DECLARE
  agent_rules integer;
  workspace_rules integer;
BEGIN
  SELECT count(*) INTO agent_rules FROM "agent_engine_settings";
  SELECT count(*) INTO workspace_rules FROM "workspace_engine_settings";
  IF agent_rules > 0 OR workspace_rules > 0 THEN
    RAISE NOTICE '0357: dropped rows: agent_engine_settings %, workspace_engine_settings %', agent_rules, workspace_rules;
  END IF;
END $$;--> statement-breakpoint
DROP TABLE "agent_engine_settings";--> statement-breakpoint
DROP TABLE "workspace_engine_settings";