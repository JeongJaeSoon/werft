-- Sign-in attempt windows shared by every API replica: failed password
-- guesses per account and per client network, and token-route requests per
-- client network. Keys are HMACs; no email or address is stored. A new,
-- empty table, so nothing here rewrites or locks an existing one.
CREATE TABLE "auth_attempt_windows" (
	"kind" text NOT NULL,
	"key" text NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"refusals" integer DEFAULT 0 NOT NULL,
	"refused" boolean DEFAULT false NOT NULL,
	CONSTRAINT "auth_attempt_windows_pk" PRIMARY KEY("kind","key"),
	CONSTRAINT "auth_attempt_windows_kind_check" CHECK ("auth_attempt_windows"."kind" IN ('account_failure', 'ip_failure', 'ip_request')),
	CONSTRAINT "auth_attempt_windows_count_check" CHECK ("auth_attempt_windows"."count" >= 0),
	CONSTRAINT "auth_attempt_windows_refusals_check" CHECK ("auth_attempt_windows"."refusals" >= 0)
);
--> statement-breakpoint
CREATE INDEX "auth_attempt_windows_started_idx" ON "auth_attempt_windows" USING btree ("window_started_at");