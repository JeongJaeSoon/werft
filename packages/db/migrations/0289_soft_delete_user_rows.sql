ALTER TABLE "github_apps" DROP CONSTRAINT "github_apps_workspace_app_uniq";--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" DROP CONSTRAINT "workspace_mcp_servers_name_uniq";--> statement-breakpoint
ALTER TABLE "env_variables" DROP CONSTRAINT "env_variables_value_check";--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" DROP CONSTRAINT "workspace_mcp_servers_oauth_check";--> statement-breakpoint
DROP INDEX "env_variables_workspace_name_uniq";--> statement-breakpoint
DROP INDEX "env_variables_agent_name_uniq";--> statement-breakpoint
DROP INDEX "login_methods_external_uniq";--> statement-breakpoint
DROP INDEX "login_methods_password_user_uniq";--> statement-breakpoint
DROP INDEX "login_methods_user_issuer_uniq";--> statement-breakpoint
DROP INDEX "login_providers_issuer_uniq";--> statement-breakpoint
ALTER TABLE "slack_config_tokens" DROP CONSTRAINT "slack_config_tokens_pkey";--> statement-breakpoint
ALTER TABLE "env_variables" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "env_variables" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "github_apps" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "github_apps" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "login_methods" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "login_methods" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "login_providers" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "login_providers" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "slack_config_tokens" ADD COLUMN "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL;--> statement-breakpoint
ALTER TABLE "slack_config_tokens" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "slack_config_tokens" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" ADD COLUMN "deleted_by" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "github_apps_workspace_app_uniq" ON "github_apps" USING btree ("workspace_id","app_id") WHERE "github_apps"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "slack_config_tokens_workspace_uniq" ON "slack_config_tokens" USING btree ("workspace_id") WHERE "slack_config_tokens"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "workspace_mcp_servers_name_uniq" ON "workspace_mcp_servers" USING btree ("workspace_id","name") WHERE "workspace_mcp_servers"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "env_variables_workspace_name_uniq" ON "env_variables" USING btree ("workspace_id","name") WHERE "env_variables"."agent_id" IS NULL AND "env_variables"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "env_variables_agent_name_uniq" ON "env_variables" USING btree ("workspace_id","agent_id","name") WHERE "env_variables"."agent_id" IS NOT NULL AND "env_variables"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "login_methods_external_uniq" ON "login_methods" USING btree ("kind","issuer","subject") WHERE "login_methods"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "login_methods_password_user_uniq" ON "login_methods" USING btree ("user_id") WHERE "login_methods"."kind" = 'password' AND "login_methods"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "login_methods_user_issuer_uniq" ON "login_methods" USING btree ("user_id","issuer") WHERE "login_methods"."kind" <> 'password' AND "login_methods"."deleted_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "login_providers_issuer_uniq" ON "login_providers" USING btree ("issuer") WHERE "login_providers"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "env_variables" ADD CONSTRAINT "env_variables_deleted_check" CHECK (("env_variables"."deleted_at" IS NULL) = ("env_variables"."deleted_by" IS NULL));--> statement-breakpoint
ALTER TABLE "env_variables" ADD CONSTRAINT "env_variables_value_check" CHECK (("env_variables"."deleted_at" IS NOT NULL OR ("env_variables"."kind" = 'plain') = ("env_variables"."value" IS NOT NULL)) AND ("env_variables"."value" IS NULL OR octet_length("env_variables"."value") <= 49152));--> statement-breakpoint
ALTER TABLE "github_apps" ADD CONSTRAINT "github_apps_deleted_check" CHECK (("github_apps"."deleted_at" IS NULL) = ("github_apps"."deleted_by" IS NULL));--> statement-breakpoint
ALTER TABLE "login_methods" ADD CONSTRAINT "login_methods_deleted_check" CHECK (("login_methods"."deleted_at" IS NULL) = ("login_methods"."deleted_by" IS NULL));--> statement-breakpoint
ALTER TABLE "login_providers" ADD CONSTRAINT "login_providers_deleted_check" CHECK (("login_providers"."deleted_at" IS NULL) = ("login_providers"."deleted_by" IS NULL));--> statement-breakpoint
ALTER TABLE "slack_config_tokens" ADD CONSTRAINT "slack_config_tokens_deleted_check" CHECK (("slack_config_tokens"."deleted_at" IS NULL) = ("slack_config_tokens"."deleted_by" IS NULL));--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" ADD CONSTRAINT "workspace_mcp_servers_deleted_check" CHECK (("workspace_mcp_servers"."deleted_at" IS NULL) = ("workspace_mcp_servers"."deleted_by" IS NULL));--> statement-breakpoint
ALTER TABLE "workspace_mcp_servers" ADD CONSTRAINT "workspace_mcp_servers_oauth_check" CHECK ("workspace_mcp_servers"."deleted_at" IS NOT NULL OR ("workspace_mcp_servers"."auth_kind" = 'oauth') = ("workspace_mcp_servers"."oauth" IS NOT NULL));