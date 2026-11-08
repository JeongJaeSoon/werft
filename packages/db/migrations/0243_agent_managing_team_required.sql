-- Agents made before managing teams (0223) may still have none. Nothing is
-- deleted and no one gains authority: every such agent goes to one holding
-- team per workspace, which has no members. Workspace admins rename it or
-- move the agents to the teams that own them.
-- Writers wait, so no row can turn up without a team before SET NOT NULL.
LOCK TABLE "agents" IN SHARE ROW EXCLUSIVE MODE;--> statement-breakpoint
-- Marks the holding team, so its agents' workspace sessions stay as visible as
-- they were without a team (axis B does not hide them).
ALTER TABLE "member_teams" ADD COLUMN "holds_unassigned" boolean DEFAULT false NOT NULL;--> statement-breakpoint
WITH needing AS (
	SELECT DISTINCT "workspace_id" FROM "agents" WHERE "managing_team_id" IS NULL
), holding AS (
	INSERT INTO "member_teams" ("id", "workspace_id", "name", "holds_unassigned")
	SELECT
		gen_random_uuid(),
		n."workspace_id",
		CASE WHEN EXISTS (
			SELECT 1 FROM "member_teams" t
			WHERE t."workspace_id" = n."workspace_id" AND t."archived_at" IS NULL AND t."name" = 'Unassigned agents'
		) THEN 'Unassigned agents (' || substr(gen_random_uuid()::text, 1, 8) || ')' ELSE 'Unassigned agents' END,
		true
	FROM needing n
	RETURNING "id", "workspace_id"
)
UPDATE "agents" a
SET "managing_team_id" = h."id"
FROM holding h
WHERE a."workspace_id" = h."workspace_id" AND a."managing_team_id" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "managing_team_id" SET NOT NULL;--> statement-breakpoint
-- Every row is indexed now, so the partial predicate from 0223 is moot.
DROP INDEX "agents_managing_team_idx";--> statement-breakpoint
CREATE INDEX "agents_managing_team_idx" ON "agents" USING btree ("managing_team_id");
