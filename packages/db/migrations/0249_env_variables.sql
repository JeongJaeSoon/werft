CREATE SEQUENCE "public"."env_variable_versions_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "env_variable_grants" (
	"workspace_id" uuid NOT NULL,
	"variable_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"allow_automation" boolean DEFAULT false NOT NULL,
	"granted_by" uuid,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "env_variable_grants_variable_id_agent_id_pk" PRIMARY KEY("variable_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "env_variables" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"value" text,
	"engine_delivery" boolean DEFAULT false NOT NULL,
	"allow_automation" boolean DEFAULT false NOT NULL,
	"grant_all" boolean DEFAULT false NOT NULL,
	"version" bigint DEFAULT nextval('env_variable_versions_seq') NOT NULL,
	"grant_version" bigint DEFAULT nextval('env_variable_versions_seq') NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "env_variables_workspace_id_uniq" UNIQUE("workspace_id","id"),
	CONSTRAINT "env_variables_name_check" CHECK ("env_variables"."name" ~ '^[A-Z][A-Z0-9_]{0,63}$'),
	CONSTRAINT "env_variables_kind_check" CHECK ("env_variables"."kind" IN ('plain','secret')),
	CONSTRAINT "env_variables_value_check" CHECK (("env_variables"."kind" = 'plain') = ("env_variables"."value" IS NOT NULL) AND ("env_variables"."value" IS NULL OR octet_length("env_variables"."value") <= 49152)),
	CONSTRAINT "env_variables_engine_delivery_check" CHECK (NOT "env_variables"."engine_delivery" OR "env_variables"."kind" = 'secret'),
	CONSTRAINT "env_variables_allow_automation_check" CHECK (NOT "env_variables"."allow_automation" OR ("env_variables"."kind" = 'secret' AND "env_variables"."agent_id" IS NOT NULL)),
	CONSTRAINT "env_variables_grant_all_check" CHECK (NOT "env_variables"."grant_all" OR ("env_variables"."kind" = 'plain' AND "env_variables"."agent_id" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "env_start" jsonb;--> statement-breakpoint
ALTER TABLE "env_variable_grants" ADD CONSTRAINT "env_variable_grants_variable_fk" FOREIGN KEY ("workspace_id","variable_id") REFERENCES "public"."env_variables"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_variable_grants" ADD CONSTRAINT "env_variable_grants_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_variables" ADD CONSTRAINT "env_variables_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "env_variables" ADD CONSTRAINT "env_variables_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "env_variables_workspace_name_uniq" ON "env_variables" USING btree ("workspace_id","name") WHERE "env_variables"."agent_id" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "env_variables_agent_name_uniq" ON "env_variables" USING btree ("workspace_id","agent_id","name") WHERE "env_variables"."agent_id" IS NOT NULL;--> statement-breakpoint
-- The snapshot without its values. Names, scopes and versions stay: they are
-- what the receipts and the console show. A snapshot that is not the shape
-- the accept writes holds nothing worth keeping and is dropped whole, so a
-- malformed row can neither block a close nor keep a value past it.
CREATE FUNCTION "env_start_without_values"(snapshot jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
	SELECT CASE
		WHEN jsonb_typeof(snapshot -> 'entries') = 'array'
			AND NOT EXISTS (
				SELECT 1 FROM jsonb_array_elements(snapshot -> 'entries') AS entry
				WHERE jsonb_typeof(entry) <> 'object'
			)
		THEN jsonb_set(
			snapshot,
			'{entries}',
			COALESCE(
				(SELECT jsonb_agg(entry - 'value') FROM jsonb_array_elements(snapshot -> 'entries') AS entry),
				'[]'::jsonb
			)
		)
		ELSE NULL
	END
$$;--> statement-breakpoint
-- Every path that closes a session passes through this one write, so the
-- plain values the session copied at accept are dropped with it.
CREATE FUNCTION "sessions_clear_env_values"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	NEW."env_start" := "env_start_without_values"(NEW."env_start");
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "sessions_clear_env_values_trg"
BEFORE UPDATE OF "admission_state" ON "sessions"
FOR EACH ROW
WHEN (NEW."admission_state" = 'closed' AND OLD."admission_state" IS DISTINCT FROM 'closed' AND NEW."env_start" IS NOT NULL)
EXECUTE FUNCTION "sessions_clear_env_values"();