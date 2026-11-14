-- The archiver of this release no longer writes a chunk's activity; the
-- defaults fill both columns, which stay NOT NULL while the previous
-- release still writes and reads them. That release takes the default as
-- a chunk with no activity: its session list then counts only the events
-- left in the table, and its archiver merges onto nothing. Setting a
-- default rewrites no row. A later migration drops both columns.
ALTER TABLE "session_event_archives" ALTER COLUMN "activity" SET DEFAULT '{"last":null,"tool_count":0,"error_count":0,"subagent_count":0,"current_tool":null,"window":{"events":0,"complete":false,"since":null}}'::jsonb;--> statement-breakpoint
ALTER TABLE "session_event_archives" ALTER COLUMN "activity_through" SET DEFAULT 0;