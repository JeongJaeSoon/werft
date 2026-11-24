-- The instruction file a release was made with (releaseInstructionsSchema),
-- which conversation judgments read instead of the repository. Nullable with
-- no default, so no row is rewritten; the statement may run again.
ALTER TABLE "agent_releases" ADD COLUMN IF NOT EXISTS "instructions_snapshot" jsonb;
