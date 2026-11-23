ALTER TABLE "extension_bundles" DROP CONSTRAINT "extension_bundles_review_check";--> statement-breakpoint
ALTER TABLE "extension_bundles" DROP CONSTRAINT "extension_bundles_auto_review_check";--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD CONSTRAINT "extension_bundles_review_check" CHECK ("extension_bundles"."review" IN ('pending','approved','rejected','superseded'));--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD CONSTRAINT "extension_bundles_auto_review_check" CHECK ("extension_bundles"."reviewed_at" IS NULL OR "extension_bundles"."reviewed_by" IS NOT NULL OR ("extension_bundles"."review" = 'approved' AND "extension_bundles"."git" IS NOT NULL) OR "extension_bundles"."review" = 'superseded');--> statement-breakpoint
-- A version still awaiting review below a newer approved one of its skill
-- would have been superseded when that one was approved.
UPDATE "extension_bundles" AS "old" SET "review" = 'superseded', "reviewed_at" = now() WHERE "old"."review" = 'pending' AND "old"."archived_at" IS NULL AND "old"."version" IS NOT NULL AND EXISTS (SELECT 1 FROM "extension_bundles" AS "newer" WHERE "newer"."workspace_id" = "old"."workspace_id" AND "newer"."name" = "old"."name" AND "newer"."review" = 'approved' AND "newer"."version" > "old"."version");
