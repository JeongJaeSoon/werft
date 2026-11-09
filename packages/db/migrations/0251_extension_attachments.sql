CREATE TABLE "extension_attachments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"agent_id" uuid,
	"bundle_id" uuid NOT NULL,
	"name" text NOT NULL,
	"mode" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_attachments_scope_check" CHECK ("extension_attachments"."scope" IN ('workspace', 'agent') AND ("extension_attachments"."scope" = 'agent') = ("extension_attachments"."agent_id" IS NOT NULL)),
	CONSTRAINT "extension_attachments_mode_check" CHECK ("extension_attachments"."mode" IN ('required', 'optional', 'forbidden')),
	CONSTRAINT "extension_attachments_name_check" CHECK ("extension_attachments"."name" ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "extensions" jsonb;--> statement-breakpoint
ALTER TABLE "extension_attachments" ADD CONSTRAINT "extension_attachments_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_attachments" ADD CONSTRAINT "extension_attachments_bundle_id_extension_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."extension_bundles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_attachments" ADD CONSTRAINT "extension_attachments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_attachments" ADD CONSTRAINT "extension_attachments_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extension_attachments_workspace_name_idx" ON "extension_attachments" USING btree ("workspace_id","name") WHERE "extension_attachments"."scope" = 'workspace';--> statement-breakpoint
CREATE UNIQUE INDEX "extension_attachments_agent_name_idx" ON "extension_attachments" USING btree ("agent_id","name") WHERE "extension_attachments"."scope" = 'agent';