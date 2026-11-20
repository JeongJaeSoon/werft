ALTER TABLE "extension_bundles" ADD COLUMN "version" integer;--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD CONSTRAINT "extension_bundles_archived_by_users_id_fk" FOREIGN KEY ("archived_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extension_bundles_workspace_name_version_idx" ON "extension_bundles" USING btree ("workspace_id","name","version") WHERE "extension_bundles"."version" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD CONSTRAINT "extension_bundles_version_check" CHECK ("extension_bundles"."version" IS NULL OR "extension_bundles"."version" >= 1);--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD CONSTRAINT "extension_bundles_archive_actor_check" CHECK (("extension_bundles"."archived_by" IS NULL) = ("extension_bundles"."archived_at" IS NULL));