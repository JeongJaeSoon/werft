CREATE SEQUENCE "public"."setup_link_epoch" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "setup_links" (
	"token_hash" "bytea" PRIMARY KEY NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"epoch" bigint NOT NULL
);
--> statement-breakpoint
-- Called once so last_value is the current epoch from the start (a fresh
-- sequence reports 1 both before and after its first nextval).
SELECT setval('"public"."setup_link_epoch"', 1);--> statement-breakpoint
-- A live owner that stops being one advances the epoch, which outdates every
-- link issued before. nextval takes no lock and is seen by all transactions at
-- once, so no interleaving of writes and issues can keep such a link usable.
CREATE OR REPLACE FUNCTION "setup_link_epoch_bump"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM nextval('"public"."setup_link_epoch"');
  RETURN NULL;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "setup_link_epoch_on_membership_change" AFTER UPDATE OF "role", "disabled_at" ON "memberships" FOR EACH ROW WHEN (OLD."role" = 'owner' AND OLD."disabled_at" IS NULL AND (NEW."role" IS DISTINCT FROM 'owner' OR NEW."disabled_at" IS NOT NULL)) EXECUTE FUNCTION "setup_link_epoch_bump"();--> statement-breakpoint
CREATE TRIGGER "setup_link_epoch_on_membership_delete" AFTER DELETE ON "memberships" FOR EACH ROW WHEN (OLD."role" = 'owner' AND OLD."disabled_at" IS NULL) EXECUTE FUNCTION "setup_link_epoch_bump"();--> statement-breakpoint
CREATE TRIGGER "setup_link_epoch_on_user_disable" AFTER UPDATE OF "disabled_at" ON "users" FOR EACH ROW WHEN (OLD."disabled_at" IS NULL AND NEW."disabled_at" IS NOT NULL) EXECUTE FUNCTION "setup_link_epoch_bump"();
