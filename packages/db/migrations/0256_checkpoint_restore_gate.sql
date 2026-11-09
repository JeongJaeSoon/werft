CREATE TABLE "checkpoint_restore_check" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "checkpoint_restore_check_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"session_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"manifest_sha256" text NOT NULL,
	"candidates_digest" text NOT NULL,
	"image_digest" text NOT NULL,
	"image_runtime" jsonb NOT NULL,
	"outcome" text NOT NULL,
	"detail" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "checkpoint_restore_check_outcome_check" CHECK ("checkpoint_restore_check"."outcome" IN ('ok', 'mismatch', 'error'))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "legacy_runtime_configs" jsonb;--> statement-breakpoint
ALTER TABLE "checkpoint_restore_check" ADD CONSTRAINT "checkpoint_restore_check_checkpoint_fk" FOREIGN KEY ("session_id","revision") REFERENCES "public"."checkpoints"("session_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "checkpoint_restore_check_latest_idx" ON "checkpoint_restore_check" USING btree ("session_id","revision","checked_at");--> statement-breakpoint
-- The gate the migration that deletes the profile tables calls first, with the
-- content ids of the worker images that stay. A live checkpoint passes only
-- when, for its current manifest, the latest check of at least one of those
-- images says ok; one no retained image checked, or only failed, stops it.
-- A check by an image that is going away proves nothing about what remains.
CREATE OR REPLACE FUNCTION "assert_checkpoint_restore_verified"(retained text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  unchecked bigint;
  failed bigint;
BEGIN
  IF retained IS NULL OR cardinality(retained) = 0 THEN
    RAISE EXCEPTION 'checkpoint restore gate needs the content ids of the worker images that stay'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Held to the end of the calling transaction, so no checkpoint can commit
  -- between this read and the delete that follows it.
  LOCK TABLE checkpoints IN SHARE ROW EXCLUSIVE MODE;
  SELECT count(*) FILTER (WHERE seen.checked = 0),
         count(*) FILTER (WHERE seen.checked > 0 AND seen.passed = 0)
    INTO unchecked, failed
    FROM checkpoints c
    CROSS JOIN LATERAL (
      SELECT count(*) AS checked,
             count(*) FILTER (WHERE latest.outcome = 'ok') AS passed
        FROM (
          SELECT DISTINCT ON (k.image_digest) k.image_digest, k.outcome
            FROM checkpoint_restore_check k
           WHERE k.session_id = c.session_id
             AND k.revision = c.revision
             AND k.manifest_sha256 = c.manifest_sha256
             AND k.image_digest = ANY (retained)
           ORDER BY k.image_digest, k.checked_at DESC, k.id DESC
        ) latest
    ) seen
   WHERE c.collected_at IS NULL;
  IF unchecked > 0 OR failed > 0 THEN
    RAISE EXCEPTION 'checkpoint restore not verified: % checkpoint(s) without a check, % with a failed one; run verify-restore --image <retained worker image> --record', unchecked, failed
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;