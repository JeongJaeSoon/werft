DROP INDEX "agents_workspace_slug_idx";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_workspace_slug_idx" ON "agents" USING btree ("workspace_id","slug") WHERE "agents"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_deleted_check" CHECK (("agents"."deleted_at" IS NULL) = ("agents"."deleted_by" IS NULL) AND ("agents"."deleted_at" IS NULL OR "agents"."status" = 'archived'));