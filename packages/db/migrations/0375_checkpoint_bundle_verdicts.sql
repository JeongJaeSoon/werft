-- Workspace bundle verifications that passed, remembered per committed
-- checkpoint so the protected-commits answer does not start git again for
-- bundles that have not changed (CheckpointStore.recordBundleVerdict). A new,
-- empty table; an older image neither reads nor writes it.
CREATE TABLE "checkpoint_bundle_verdicts" (
	"session_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"verdict_key" text NOT NULL,
	"prerequisite_revisions" integer[] NOT NULL,
	"verified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoint_bundle_verdicts_session_id_revision_pk" PRIMARY KEY("session_id","revision")
);
--> statement-breakpoint
ALTER TABLE "checkpoint_bundle_verdicts" ADD CONSTRAINT "checkpoint_bundle_verdicts_checkpoint_fk" FOREIGN KEY ("session_id","revision") REFERENCES "public"."checkpoints"("session_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- A remembered pass must not outlive what it was made on, whichever path
-- removes that: a checkpoint row deleted (with its session, or any other
-- way), collected (garbage collection and the lost-checkpoint forget set
-- collected_at) or re-pinned to another manifest. Its own verdict goes, and
-- so does every verdict whose bundles build on that checkpoint's. In the
-- database rather than in each of those paths, so a new one cannot forget it.
CREATE FUNCTION "checkpoints_forget_bundle_verdicts"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	DELETE FROM "checkpoint_bundle_verdicts"
	WHERE "session_id" = OLD."session_id"
		AND ("revision" = OLD."revision" OR "prerequisite_revisions" @> ARRAY[OLD."revision"]);
	RETURN NULL;
END
$$;--> statement-breakpoint
CREATE TRIGGER "checkpoints_forget_bundle_verdicts"
AFTER DELETE OR UPDATE OF "manifest_ref", "manifest_sha256", "manifest_version", "collected_at" ON "checkpoints"
FOR EACH ROW
EXECUTE FUNCTION "checkpoints_forget_bundle_verdicts"();
