CREATE TABLE "extension_bundles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"digest" text NOT NULL,
	"label" text NOT NULL,
	"source" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"manifest" jsonb NOT NULL,
	"review" text DEFAULT 'pending' NOT NULL,
	"registered_by" uuid NOT NULL,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	CONSTRAINT "extension_bundles_digest_check" CHECK ("extension_bundles"."digest" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "extension_bundles_name_check" CHECK ("extension_bundles"."name" ~ '^[a-z0-9][a-z0-9-]{0,63}$'),
	CONSTRAINT "extension_bundles_label_check" CHECK (char_length("extension_bundles"."label") BETWEEN 1 AND 200),
	CONSTRAINT "extension_bundles_source_check" CHECK ("extension_bundles"."source" IN ('upload','github')),
	CONSTRAINT "extension_bundles_review_check" CHECK ("extension_bundles"."review" IN ('pending','approved','rejected')),
	CONSTRAINT "extension_bundles_review_actor_check" CHECK (("extension_bundles"."review" = 'pending') = ("extension_bundles"."reviewed_by" IS NULL AND "extension_bundles"."reviewed_at" IS NULL)),
	CONSTRAINT "extension_bundles_size_check" CHECK ("extension_bundles"."size_bytes" > 0),
	CONSTRAINT "extension_bundles_manifest_check" CHECK (jsonb_typeof("extension_bundles"."manifest") = 'object')
);
--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD CONSTRAINT "extension_bundles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD CONSTRAINT "extension_bundles_registered_by_users_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "extension_bundles" ADD CONSTRAINT "extension_bundles_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extension_bundles_workspace_digest_idx" ON "extension_bundles" USING btree ("workspace_id","digest");