-- Slack's rate limits as its 429s told them (94S-2274): until blocked_until
-- the outbox sends nothing an installation's scope covers (one channel's
-- posts, or a method such as chat.update), from any replica. A new, empty
-- table; an older image neither reads nor writes it.
CREATE TABLE "slack_outbox_rate_blocks" (
	"installation_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"blocked_until" timestamp with time zone NOT NULL,
	CONSTRAINT "slack_outbox_rate_blocks_installation_id_scope_pk" PRIMARY KEY("installation_id","scope")
);
--> statement-breakpoint
ALTER TABLE "slack_outbox_rate_blocks" ADD CONSTRAINT "slack_outbox_rate_blocks_installation_id_slack_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."slack_installations"("id") ON DELETE cascade ON UPDATE no action;