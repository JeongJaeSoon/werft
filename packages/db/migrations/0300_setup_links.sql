CREATE TABLE "setup_links" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
-- A setup link opens bootstrap only while no live owner exists. Whatever makes
-- an owner live (bootstrap, an accepted owner invite, a role change, an account
-- or membership enabled again) retires every link, so a link issued before
-- cannot reopen recovery once that owner is lost again.
CREATE OR REPLACE FUNCTION "setup_links_retire"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM "setup_links"
  WHERE EXISTS (
    SELECT 1 FROM "memberships" m JOIN "users" u ON u."id" = m."user_id"
    WHERE m."role" = 'owner' AND m."disabled_at" IS NULL AND u."disabled_at" IS NULL
  );
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "setup_links_retire_on_membership" AFTER INSERT OR UPDATE OF "role", "disabled_at" ON "memberships" FOR EACH STATEMENT EXECUTE FUNCTION "setup_links_retire"();--> statement-breakpoint
CREATE TRIGGER "setup_links_retire_on_user" AFTER UPDATE OF "disabled_at" ON "users" FOR EACH STATEMENT EXECUTE FUNCTION "setup_links_retire"();
