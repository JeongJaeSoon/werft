ALTER TABLE "catalog_repositories" DROP CONSTRAINT "catalog_repositories_credential_check";--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD COLUMN "carried_auth" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD COLUMN "carried_binding" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "carried_auth" jsonb;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "carried_auth" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD CONSTRAINT "catalog_repositories_credential_check" CHECK (CASE "catalog_repositories"."auth_kind"
        WHEN 'github_app' THEN "catalog_repositories"."auth" IS NULL AND "catalog_repositories"."credential_source" IS NULL
        WHEN 'none' THEN "catalog_repositories"."auth" IS NULL AND "catalog_repositories"."credential_source" IS NULL
        WHEN 'github_app_explicit' THEN "catalog_repositories"."auth" IS NOT NULL AND "catalog_repositories"."credential_source" IN ('stored', 'external')
        ELSE "catalog_repositories"."auth" IS NOT NULL AND "catalog_repositories"."credential_source" IN ('stored', 'external')
      END);--> statement-breakpoint
-- A replica that has not read a carry yet (or a build before it) still writes
-- the repository's old binding; it is stored as the new one, which the
-- catalog now compares. A rollback clears carried_binding and so this.
CREATE OR REPLACE FUNCTION "push_requests_carried_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."repository_binding" := COALESCE((SELECT "carried_binding"->>'to' FROM "catalog_repositories" WHERE "carried_binding"->>'from' = NEW."repository_binding" LIMIT 1), NEW."repository_binding");
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "worker_credentials_carried_binding"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW."binding" := COALESCE((SELECT "carried_binding"->>'to' FROM "catalog_repositories" WHERE "carried_binding"->>'from' = NEW."binding" LIMIT 1), NEW."binding");
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "push_requests_carried_binding" BEFORE INSERT ON "push_requests" FOR EACH ROW WHEN (NEW."repository_binding" IS NOT NULL) EXECUTE FUNCTION "push_requests_carried_binding"();--> statement-breakpoint
CREATE TRIGGER "worker_credentials_carried_binding" BEFORE INSERT ON "worker_credentials" FOR EACH ROW WHEN (NEW."purpose" = 'repository') EXECUTE FUNCTION "worker_credentials_carried_binding"();