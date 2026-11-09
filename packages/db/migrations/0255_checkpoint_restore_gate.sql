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
-- The gate the migration that deletes the profile tables calls first. A live
-- checkpoint passes only when the latest check recorded against its current
-- manifest says ok; one nobody checked, or checked and failed, stops it.
CREATE OR REPLACE FUNCTION "assert_checkpoint_restore_verified"() RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  unchecked bigint;
  failed bigint;
BEGIN
  SELECT count(*) FILTER (WHERE latest.id IS NULL),
         count(*) FILTER (WHERE latest.id IS NOT NULL AND latest.outcome <> 'ok')
    INTO unchecked, failed
    FROM checkpoints c
    LEFT JOIN LATERAL (
      SELECT k.id, k.outcome
        FROM checkpoint_restore_check k
       WHERE k.session_id = c.session_id
         AND k.revision = c.revision
         AND k.manifest_sha256 = c.manifest_sha256
       ORDER BY k.checked_at DESC, k.id DESC
       LIMIT 1
    ) latest ON true
   WHERE c.collected_at IS NULL;
  IF unchecked > 0 OR failed > 0 THEN
    RAISE EXCEPTION 'checkpoint restore not verified: % checkpoint(s) without a check, % with a failed one; run verify-restore --image <retained worker image> --record', unchecked, failed
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;