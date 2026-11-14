ALTER TABLE "catalog_repositories" DROP CONSTRAINT "catalog_repositories_credential_check";--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD COLUMN "carried_auth" jsonb;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "carried_auth" jsonb;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD COLUMN "carried_auth" jsonb;--> statement-breakpoint
ALTER TABLE "catalog_repositories" ADD CONSTRAINT "catalog_repositories_credential_check" CHECK (CASE "catalog_repositories"."auth_kind"
        WHEN 'github_app' THEN "catalog_repositories"."auth" IS NULL AND "catalog_repositories"."credential_source" IS NULL
        WHEN 'none' THEN "catalog_repositories"."auth" IS NULL AND "catalog_repositories"."credential_source" IS NULL
        WHEN 'github_app_explicit' THEN "catalog_repositories"."auth" IS NOT NULL AND "catalog_repositories"."credential_source" IN ('stored', 'external')
        ELSE "catalog_repositories"."auth" IS NOT NULL AND "catalog_repositories"."credential_source" IN ('stored', 'external')
      END);