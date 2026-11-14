-- When migrate's automatic settings seed decided: it imports the legacy
-- directory and the settings document into an empty installation once, and
-- leaves an installation that already holds settings to the console. Null
-- until then; an existing installation gets it on its first migrate.
--
-- The previous release ignores the column and imports both on every deploy
-- again; keep it when going back.
ALTER TABLE "settings_generation" ADD COLUMN "seed_decided_at" timestamp with time zone;
