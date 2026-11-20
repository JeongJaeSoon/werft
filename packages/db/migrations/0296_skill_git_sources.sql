CREATE TABLE "skill_git_sources" (
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"connection_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"repository_id" bigint NOT NULL,
	"repository" text NOT NULL,
	"path" text NOT NULL,
	"ref" text NOT NULL,
	"sync_enabled" boolean DEFAULT true NOT NULL,
	"last_checked_at" timestamp with time zone,
	"last_check" jsonb,
	"checking_until" timestamp with time zone,
	"checking_token" uuid,
	"check_again" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_git_sources_workspace_id_name_pk" PRIMARY KEY("workspace_id","name"),
	CONSTRAINT "skill_git_sources_name_check" CHECK ("skill_git_sources"."name" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	CONSTRAINT "skill_git_sources_ids_check" CHECK ("skill_git_sources"."installation_id" > 0 AND "skill_git_sources"."repository_id" > 0)
);
--> statement-breakpoint
ALTER TABLE "extension_bundles" ALTER COLUMN "registered_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD COLUMN "git" jsonb;--> statement-breakpoint
ALTER TABLE "skill_git_sources" ADD CONSTRAINT "skill_git_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_git_sources" ADD CONSTRAINT "skill_git_sources_connection_id_github_apps_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_git_sources" ADD CONSTRAINT "skill_git_sources_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skill_git_sources_push_idx" ON "skill_git_sources" USING btree ("installation_id","repository_id");--> statement-breakpoint
CREATE INDEX "skill_git_sources_due_idx" ON "skill_git_sources" USING btree ("last_checked_at");--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD CONSTRAINT "extension_bundles_git_check" CHECK (("extension_bundles"."git" IS NULL OR "extension_bundles"."source" = 'github') AND ("extension_bundles"."registered_by" IS NOT NULL OR "extension_bundles"."git" IS NOT NULL));