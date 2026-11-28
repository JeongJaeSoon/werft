-- What a connection's endpoint was registered as: public, private, or null
-- for a row from before and for an imported one, which the egress proxy's own
-- lists go on deciding. Expand only: an image from before neither reads nor
-- writes the column, and a row it inserts holds null. provider_connections is
-- a handful of rows, so the CHECK's scan is nothing.
ALTER TABLE "provider_connections" ADD COLUMN "network" text;--> statement-breakpoint
ALTER TABLE "provider_connections" ADD CONSTRAINT "provider_connections_network_check" CHECK ("provider_connections"."network" IN ('public', 'private'));