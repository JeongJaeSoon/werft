ALTER TABLE "agents" ADD COLUMN "conversation_rollout" text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD COLUMN "listen" text DEFAULT 'free' NOT NULL;--> statement-breakpoint
-- A channel bound before this column listens as its agent's mention_only said; a new one listens to every message.
UPDATE "surface_bindings" SET "listen" = 'mention' FROM "agents" WHERE "agents"."id" = "surface_bindings"."agent_id" AND "agents"."slack_mention_only";--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_conversation_rollout_check" CHECK ("agents"."conversation_rollout" IN ('off','shadow','on'));--> statement-breakpoint
ALTER TABLE "surface_bindings" ADD CONSTRAINT "surface_bindings_listen_check" CHECK ("surface_bindings"."listen" IN ('free','mention','off'));
