-- Who may sign in with a password, for the whole installation: everyone
-- (`on`), or only the emergency admin (`emergency_only`). One row, and the
-- changes that depend on it queue on its lock.
--
-- The previous release reads none of this, so it runs on the migrated
-- database. To go back for good: DROP TABLE "login_settings", and, once no
-- password_resets row has a NULL issued_by, set the column NOT NULL again.
CREATE TABLE "login_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"password_login" text DEFAULT 'on' NOT NULL,
	"emergency_admin_user_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "login_settings_single_row_check" CHECK ("login_settings"."id"),
	CONSTRAINT "login_settings_password_login_check" CHECK ("login_settings"."password_login" IN ('on', 'emergency_only')),
	CONSTRAINT "login_settings_emergency_admin_check" CHECK ("login_settings"."password_login" = 'on' OR "login_settings"."emergency_admin_user_id" IS NOT NULL)
);
--> statement-breakpoint
-- A link the operator CLI issues has no user behind it.
ALTER TABLE "password_resets" ALTER COLUMN "issued_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "login_settings" ADD CONSTRAINT "login_settings_emergency_admin_user_id_users_id_fk" FOREIGN KEY ("emergency_admin_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The row, with the first emergency admin: of the owners who can sign in
-- with a password today (account and membership on, a password set), the
-- one whose membership is oldest. An installation whose owners all sign in
-- through a provider gets none, and cannot close passwords until one sets a
-- password through the operator CLI's link. A new installation gets its
-- emergency admin at bootstrap.
INSERT INTO "login_settings" ("emergency_admin_user_id")
SELECT (
	SELECT "memberships"."user_id"
	FROM "memberships"
	JOIN "users" ON "users"."id" = "memberships"."user_id"
	WHERE "memberships"."role" = 'owner'
		AND "memberships"."disabled_at" IS NULL
		AND "users"."disabled_at" IS NULL
		AND "users"."password_hash" IS NOT NULL
	ORDER BY "memberships"."created_at", "memberships"."user_id"
	LIMIT 1
);