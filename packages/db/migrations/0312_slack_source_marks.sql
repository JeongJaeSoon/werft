CREATE TABLE "deleted_sources" (
	"workspace_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"ts" text NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deleted_sources_workspace_id_team_id_channel_id_ts_pk" PRIMARY KEY("workspace_id","team_id","channel_id","ts")
);
--> statement-breakpoint
CREATE TABLE "edited_sources" (
	"workspace_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"channel_id" text NOT NULL,
	"ts" text NOT NULL,
	"edited_at" timestamp with time zone NOT NULL,
	"marked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "edited_sources_workspace_id_team_id_channel_id_ts_pk" PRIMARY KEY("workspace_id","team_id","channel_id","ts")
);
--> statement-breakpoint
ALTER TABLE "deleted_sources" ADD CONSTRAINT "deleted_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "edited_sources" ADD CONSTRAINT "edited_sources_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "deleted_sources_marked_idx" ON "deleted_sources" USING btree ("marked_at");--> statement-breakpoint
CREATE INDEX "edited_sources_marked_idx" ON "edited_sources" USING btree ("marked_at");