-- A channel's report mode is null until a person picks one (v1-b/P3); the
-- thread then hears by its agent's conversation rollout: progress when on,
-- per_step while off or shadow, as before. No writer ever set the column
-- (0326 added it with the per_step default and nothing wrote it since), so
-- every per_step stored is that default and goes back to null here. A null
-- reads as per_step on an older image too. surface_bindings is small. Every
-- statement may run again.
ALTER TABLE "surface_bindings" ALTER COLUMN "report_mode" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "surface_bindings" ALTER COLUMN "report_mode" DROP NOT NULL;--> statement-breakpoint
UPDATE "surface_bindings" SET "report_mode" = NULL WHERE "report_mode" = 'per_step';
