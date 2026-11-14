-- Installation settings an owner keeps in the console, one row per key, in
-- place of environment variables. A key has no row until an owner saves it
-- or the first start of the release that moves it carries the old env value
-- in; rows are never deleted.
--
-- The previous release reads none of this, so it runs on the migrated
-- database with its env as before. Keep the table when going back: the next
-- upgrade then finds the rows and carries nothing in again.
CREATE TABLE "installation_config" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
