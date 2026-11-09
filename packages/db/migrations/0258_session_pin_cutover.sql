CREATE TABLE IF NOT EXISTS "session_pin_cutover" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"authoritative" boolean DEFAULT false NOT NULL,
	"flipped_at" timestamp with time zone,
	CONSTRAINT "session_pin_cutover_single" CHECK ("session_pin_cutover"."id" = 1),
	CONSTRAINT "session_pin_cutover_flipped" CHECK ("session_pin_cutover"."authoritative" = ("session_pin_cutover"."flipped_at" IS NOT NULL))
);--> statement-breakpoint
INSERT INTO "session_pin_cutover" ("id") VALUES (1) ON CONFLICT DO NOTHING;
