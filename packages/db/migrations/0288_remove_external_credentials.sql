ALTER TABLE "catalog_repositories" DROP CONSTRAINT "catalog_repositories_credential_check";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_console_stored_check";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_credential_source_check";--> statement-breakpoint
ALTER TABLE "provider_connections" DROP CONSTRAINT "provider_connections_console_stored_check";--> statement-breakpoint
ALTER TABLE "provider_connections" DROP CONSTRAINT "provider_connections_credential_source_check";--> statement-breakpoint
-- A credential named by env or Secrets Manager becomes the row's own stored
-- value, which no row holds yet: the row shows as needing one until a person
-- sets it. Its old auth is kept in carried_auth for a rollback.
SET LOCAL lock_timeout = '30s';--> statement-breakpoint
LOCK TABLE "catalog_repositories", "provider_connections", "mcp_servers", "worker_credentials" IN EXCLUSIVE MODE;--> statement-breakpoint
-- An explicit App's repository binding hashes where its key comes from
-- (repositoryBinding in packages/platform), so the move changes it. Both are
-- canonicalJson of { fingerprint_version, id, repository } with the key left
-- out: keys sorted, no spaces, strings escaped as JSON.
UPDATE "catalog_repositories" AS r SET "carried_binding" = jsonb_build_object(
  'from', 'sha256:' || encode(sha256(convert_to(b."prefix" || b."old_ref" || b."suffix", 'UTF8')), 'hex'),
  'to', 'sha256:' || encode(sha256(convert_to(b."prefix" || b."new_ref" || b."suffix", 'UTF8')), 'hex'))
FROM (
  SELECT "id",
    '{"fingerprint_version":1,"id":' || to_jsonb("id")::text
      || ',"repository":{"auth":{"api_base":' || to_jsonb(COALESCE("auth"->>'api_base', 'https://api.github.com'))::text
      || ',"app_id":' || ("auth"->'app_id')::text
      || ',"installation_id":' || ("auth"->'installation_id')::text
      || ',"kind":"github_app","ref":' AS "prefix",
    CASE WHEN "auth" ? 'value_env'
      THEN '{"value_env":' || to_jsonb("auth"->>'value_env')::text || '}'
      ELSE '{"secret_id":' || to_jsonb("auth"->>'secret_id')::text || '}'
    END AS "old_ref",
    '{"stored":' || to_jsonb('repository:' || "id")::text || '}' AS "new_ref",
    '},"branch":' || to_jsonb("branch")::text || ',"url":' || to_jsonb("url")::text || '}}' AS "suffix"
  FROM "catalog_repositories"
  WHERE "auth_kind" = 'github_app_explicit' AND "credential_source" = 'external'
    AND "auth" ?| array['value_env', 'secret_id']
) AS b
WHERE r."id" = b."id";--> statement-breakpoint
-- push_requests grows, so its rows on the old binding move when a person sets
-- the key (rebindCarriedPushes in packages/db); its insert trigger already
-- writes the new binding for the old one.
UPDATE "worker_credentials" AS w SET "binding" = r."carried_binding"->>'to'
FROM "catalog_repositories" AS r
WHERE r."credential_source" = 'external' AND r."carried_binding" IS NOT NULL
  AND w."purpose" = 'repository' AND w."binding" = r."carried_binding"->>'from';--> statement-breakpoint
UPDATE "catalog_repositories" SET
  "carried_auth" = "auth",
  "auth" = ("auth" - 'value_env' - 'secret_id') || jsonb_build_object('stored', 'repository:' || "id"),
  "credential_source" = 'stored',
  "version" = "version" + 1,
  "updated_by" = NULL,
  "updated_at" = now()
WHERE "credential_source" = 'external';--> statement-breakpoint
UPDATE "provider_connections" SET
  "carried_auth" = "definition"->'auth',
  "definition" = jsonb_set("definition", '{auth}', (("definition"->'auth') - 'value_env' - 'secret_id') || jsonb_build_object('stored', 'connection:' || "id")),
  "credential_source" = 'stored'
WHERE "credential_source" = 'external';--> statement-breakpoint
UPDATE "mcp_servers" SET
  "carried_auth" = "auth",
  "auth" = ("auth" - 'value_env' - 'secret_id') || jsonb_build_object('stored', 'mcp:' || "id"),
  "credential_source" = 'stored'
WHERE "credential_source" = 'external';--> statement-breakpoint
-- A row made in the console commits with its value (the import may still
-- add one that needs it). Checked at commit, as the value is sealed after
-- the row; the slot is the oldest workspace's, as secretOwnerWorkspace's.
CREATE OR REPLACE FUNCTION "settings_console_value_check"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "secret_values"
    WHERE "purpose" = 'settings_credential'
      AND "owner_ref" = TG_ARGV[0] || ':' || NEW."id"
      AND "workspace_id" = (SELECT "id" FROM "workspaces" ORDER BY "created_at", "id" LIMIT 1)
  ) THEN
    RAISE EXCEPTION '%:% was made in the console without its value', TG_ARGV[0], NEW."id"
      USING ERRCODE = 'check_violation', CONSTRAINT = TG_NAME;
  END IF;
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "provider_connections_console_value" AFTER INSERT ON "provider_connections" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."origin" = 'console') EXECUTE FUNCTION "settings_console_value_check"('connection');--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "mcp_servers_console_value" AFTER INSERT ON "mcp_servers" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW."origin" = 'console') EXECUTE FUNCTION "settings_console_value_check"('mcp');--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD CONSTRAINT "catalog_repositories_credential_check" CHECK (CASE "catalog_repositories"."auth_kind"
        WHEN 'github_app' THEN "catalog_repositories"."auth" IS NULL AND "catalog_repositories"."credential_source" IS NULL
        WHEN 'none' THEN "catalog_repositories"."auth" IS NULL AND "catalog_repositories"."credential_source" IS NULL
        ELSE "catalog_repositories"."credential_source" = 'stored' AND COALESCE("catalog_repositories"."auth" ? 'stored' AND NOT "catalog_repositories"."auth" ?| array['value_env', 'secret_id'], false)
      END);--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_credential_source_check" CHECK ("mcp_servers"."credential_source" = 'stored' AND COALESCE("mcp_servers"."auth" ? 'stored' AND NOT "mcp_servers"."auth" ?| array['value_env', 'secret_id'], false));--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_credential_source_check" CHECK ("provider_connections"."credential_source" = 'stored' AND COALESCE("provider_connections"."definition"->'auth' ? 'stored' AND NOT "provider_connections"."definition"->'auth' ?| array['value_env', 'secret_id'], false));