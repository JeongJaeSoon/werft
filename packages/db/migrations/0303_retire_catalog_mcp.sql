CREATE TABLE "retired_agent_mcp_settings" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"server" text,
	"allowed_tools" jsonb NOT NULL,
	"copied" boolean NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retired_catalog_mcp" (
	"name" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"credential_ref" text NOT NULL,
	"retired_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "retired_catalog_mcp_notices" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"server" text NOT NULL,
	"noted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- The catalog writers' order first (lockCatalogWrites): the advisory lock,
-- then the generation row the mcp_servers trigger bumps. Then every agent
-- writer drains: some insert into agents and agent_versions without the
-- catalog lock, and every version or release write touches agents first.
SELECT pg_advisory_xact_lock(hashtext('catalog-repositories'));--> statement-breakpoint
SELECT 1 FROM "settings_generation" FOR UPDATE;--> statement-breakpoint
LOCK TABLE "agents" IN EXCLUSIVE MODE;--> statement-breakpoint
-- After agents: a session create holds its agent row, then inserts into
-- sessions, which this constraint's lock on sessions would block.
ALTER TABLE "retired_catalog_mcp_notices" ADD CONSTRAINT "retired_catalog_mcp_notices_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE FUNCTION "refuse_catalog_mcp_write"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'installation catalog MCP servers are retired: register a workspace MCP server instead'
    USING ERRCODE = 'check_violation';
END;
$$;--> statement-breakpoint
CREATE FUNCTION "card_names_catalog_mcp"(card jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(card #> '{capabilities,mcp}', 'null'::jsonb) NOT IN ('null'::jsonb, '[]'::jsonb)
$$;--> statement-breakpoint
CREATE FUNCTION "version_names_catalog_mcp"(version_id uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT "card_names_catalog_mcp"("card") FROM "agent_versions" WHERE "id" = version_id), false)
$$;--> statement-breakpoint
CREATE TRIGGER "mcp_servers_retired" BEFORE INSERT OR UPDATE ON "mcp_servers" FOR EACH ROW EXECUTE FUNCTION "refuse_catalog_mcp_write"();--> statement-breakpoint
CREATE TRIGGER "agent_mcp_settings_retired" BEFORE INSERT OR UPDATE ON "agent_mcp_settings" FOR EACH ROW EXECUTE FUNCTION "refuse_catalog_mcp_write"();--> statement-breakpoint
CREATE TRIGGER "agent_versions_catalog_mcp_retired" BEFORE INSERT ON "agent_versions" FOR EACH ROW WHEN ("card_names_catalog_mcp"(NEW."card")) EXECUTE FUNCTION "refuse_catalog_mcp_write"();--> statement-breakpoint
CREATE TRIGGER "agent_releases_catalog_mcp_retired" BEFORE INSERT ON "agent_releases" FOR EACH ROW WHEN ("version_names_catalog_mcp"(NEW."version_id")) EXECUTE FUNCTION "refuse_catalog_mcp_write"();--> statement-breakpoint
CREATE TRIGGER "agents_draft_catalog_mcp_retired" BEFORE UPDATE OF "draft_version_id" ON "agents" FOR EACH ROW WHEN (NEW."draft_version_id" IS DISTINCT FROM OLD."draft_version_id" AND "version_names_catalog_mcp"(NEW."draft_version_id")) EXECUTE FUNCTION "refuse_catalog_mcp_write"();--> statement-breakpoint
-- Counts and names only: a URL, a reference or a value stays out of the log.
DO $$
DECLARE
  servers integer;
  names text;
  selections integer;
BEGIN
  SELECT count(*), COALESCE(string_agg("id", ', ' ORDER BY "id"), '') INTO servers, names FROM "mcp_servers";
  SELECT count(*) INTO selections FROM "agent_mcp_settings";
  IF servers > 0 OR selections > 0 THEN
    RAISE NOTICE '0303: % catalog MCP servers retired (%), % agent catalog selections retired', servers, names, selections;
  END IF;
END $$;--> statement-breakpoint
-- Taken after the agents lock, not now() (this transaction's start): every
-- session an old host created, holding its agent row, committed before it.
INSERT INTO "retired_catalog_mcp" ("name", "url", "credential_ref", "retired_at")
  SELECT "id", "url", "credential_ref", clock_timestamp() FROM "mcp_servers";--> statement-breakpoint
INSERT INTO "retired_agent_mcp_settings" ("agent_id", "workspace_id", "server", "allowed_tools", "copied")
  SELECT "agent_id", "workspace_id", "server", "allowed_tools", "updated_by" IS NULL FROM "agent_mcp_settings";--> statement-breakpoint
DELETE FROM "secret_values"
  WHERE "purpose" = 'settings_credential'
    AND "owner_ref" IN (SELECT 'mcp:' || "id" FROM "mcp_servers");--> statement-breakpoint
DELETE FROM "mcp_servers";--> statement-breakpoint
DELETE FROM "agent_mcp_settings";
