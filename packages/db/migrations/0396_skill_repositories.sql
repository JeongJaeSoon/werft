CREATE TABLE "skill_repositories" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"repository" text NOT NULL,
	"ref" text NOT NULL,
	"access" text DEFAULT 'public' NOT NULL,
	"connection_id" uuid NOT NULL,
	"installation_id" bigint NOT NULL,
	"owner_id" bigint NOT NULL,
	"license" text,
	"generation" bigint DEFAULT 1 NOT NULL,
	"last_commit" text,
	"last_sync" jsonb,
	"last_checked_at" timestamp with time zone,
	"checking_until" timestamp with time zone,
	"checking_token" uuid,
	"check_again" jsonb,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by" uuid,
	CONSTRAINT "skill_repositories_access_check" CHECK ("skill_repositories"."access" IN ('public')),
	CONSTRAINT "skill_repositories_ids_check" CHECK ("skill_repositories"."installation_id" > 0 AND "skill_repositories"."repository_id" > 0 AND "skill_repositories"."owner_id" > 0 AND "skill_repositories"."generation" > 0),
	CONSTRAINT "skill_repositories_removed_check" CHECK (("skill_repositories"."removed_at" IS NULL) = ("skill_repositories"."removed_by" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "skill_repository_skills" (
	"id" uuid PRIMARY KEY NOT NULL,
	"skill_repository_id" uuid NOT NULL,
	"path" text NOT NULL,
	"name" text,
	"description" text,
	"license" text,
	"tree_sha" text NOT NULL,
	"passed_tree_sha" text,
	"file_count" integer NOT NULL,
	"total_bytes" bigint NOT NULL,
	"has_scripts" boolean NOT NULL,
	"listing_issues" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"present" boolean DEFAULT true NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"enabled_by" uuid,
	"enabled_at" timestamp with time zone,
	"enable_grant_id" uuid,
	"last_gate" jsonb,
	"notice" jsonb,
	"acknowledged_at" timestamp with time zone,
	"acknowledged_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_repository_skills_name_check" CHECK ("skill_repository_skills"."name" IS NULL OR "skill_repository_skills"."name" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	CONSTRAINT "skill_repository_skills_enabled_check" CHECK (NOT "skill_repository_skills"."enabled" OR "skill_repository_skills"."enable_grant_id" IS NOT NULL)
);
--> statement-breakpoint
ALTER TABLE "skill_git_sources" ADD COLUMN "repository_source_id" uuid;--> statement-breakpoint
ALTER TABLE "skill_repositories" ADD CONSTRAINT "skill_repositories_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_repositories" ADD CONSTRAINT "skill_repositories_connection_id_github_apps_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."github_apps"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_repositories" ADD CONSTRAINT "skill_repositories_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_repositories" ADD CONSTRAINT "skill_repositories_removed_by_users_id_fk" FOREIGN KEY ("removed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_repository_skills" ADD CONSTRAINT "skill_repository_skills_skill_repository_id_skill_repositories_id_fk" FOREIGN KEY ("skill_repository_id") REFERENCES "public"."skill_repositories"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_repository_skills" ADD CONSTRAINT "skill_repository_skills_enabled_by_users_id_fk" FOREIGN KEY ("enabled_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_repository_skills" ADD CONSTRAINT "skill_repository_skills_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_repositories_workspace_repository_uniq" ON "skill_repositories" USING btree ("workspace_id","repository_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skill_repository_skills_path_uniq" ON "skill_repository_skills" USING btree ("skill_repository_id","path");--> statement-breakpoint
ALTER TABLE "skill_git_sources" ADD CONSTRAINT "skill_git_sources_repository_source_id_skill_repositories_id_fk" FOREIGN KEY ("repository_source_id") REFERENCES "public"."skill_repositories"("id") ON DELETE no action ON UPDATE no action;