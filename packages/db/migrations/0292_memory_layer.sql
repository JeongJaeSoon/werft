CREATE TABLE "memory_candidates" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"source_session_id" uuid,
	"source_document_id" uuid,
	"source_revision" integer,
	"releaser_user_id" uuid NOT NULL,
	"released_by" uuid,
	"released_at" timestamp with time zone,
	"released_body_sha256" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_candidates_source_check" CHECK (("memory_candidates"."source_session_id" IS NULL OR "memory_candidates"."source_document_id" IS NULL) AND ("memory_candidates"."source_document_id" IS NULL) = ("memory_candidates"."source_revision" IS NULL)),
	CONSTRAINT "memory_candidates_release_check" CHECK (("memory_candidates"."released_by" IS NULL) = ("memory_candidates"."released_at" IS NULL) AND ("memory_candidates"."released_by" IS NULL) = ("memory_candidates"."released_body_sha256" IS NULL) AND ("memory_candidates"."released_body_sha256" IS NULL OR "memory_candidates"."released_body_sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "memory_derivations" (
	"workspace_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"derives_from_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_derivations_pk" PRIMARY KEY("document_id","derives_from_id"),
	CONSTRAINT "memory_derivations_not_self_check" CHECK ("memory_derivations"."document_id" <> "memory_derivations"."derives_from_id")
);
--> statement-breakpoint
CREATE TABLE "memory_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"scope" text NOT NULL,
	"session_id" uuid,
	"subject_user_id" uuid,
	"agent_id" uuid,
	"state" text NOT NULL,
	"current_revision" integer,
	"ancestor_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"personal_subjects" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_documents_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "memory_documents_scope_check" CHECK ("memory_documents"."scope" IN ('session', 'personal', 'agent', 'workspace')),
	CONSTRAINT "memory_documents_state_check" CHECK ("memory_documents"."state" IN ('candidate', 'active', 'quarantined', 'superseded', 'deleted')),
	CONSTRAINT "memory_documents_scope_key_check" CHECK (CASE "memory_documents"."scope"
        WHEN 'session' THEN "memory_documents"."session_id" IS NOT NULL AND "memory_documents"."subject_user_id" IS NULL AND "memory_documents"."agent_id" IS NULL
        WHEN 'personal' THEN "memory_documents"."session_id" IS NULL AND "memory_documents"."subject_user_id" IS NOT NULL AND "memory_documents"."agent_id" IS NULL
        WHEN 'agent' THEN "memory_documents"."session_id" IS NULL AND "memory_documents"."subject_user_id" IS NULL AND "memory_documents"."agent_id" IS NOT NULL
        WHEN 'workspace' THEN "memory_documents"."session_id" IS NULL AND "memory_documents"."subject_user_id" IS NULL AND "memory_documents"."agent_id" IS NULL
        ELSE false END),
	CONSTRAINT "memory_documents_active_revision_check" CHECK ("memory_documents"."state" <> 'active' OR "memory_documents"."current_revision" IS NOT NULL),
	CONSTRAINT "memory_documents_arrays_check" CHECK (coalesce(array_ndims("memory_documents"."ancestor_ids"), 1) = 1 AND coalesce(array_ndims("memory_documents"."personal_subjects"), 1) = 1 AND NOT ("memory_documents"."id" = ANY("memory_documents"."ancestor_ids")))
);
--> statement-breakpoint
CREATE TABLE "memory_promotions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"target_document_id" uuid NOT NULL,
	"target_revision" integer NOT NULL,
	"target_scope" text NOT NULL,
	"source_session_id" uuid,
	"source_document_id" uuid,
	"source_revision" integer,
	"source_body_sha256" text,
	"released_body_sha256" text NOT NULL,
	"released_by" uuid NOT NULL,
	"released_at" timestamp with time zone NOT NULL,
	"adopted_by" uuid NOT NULL,
	"adopted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_promotions_target_scope_check" CHECK ("memory_promotions"."target_scope" IN ('personal', 'agent', 'workspace')),
	CONSTRAINT "memory_promotions_source_check" CHECK (("memory_promotions"."source_session_id" IS NULL OR "memory_promotions"."source_document_id" IS NULL) AND ("memory_promotions"."source_document_id" IS NULL) = ("memory_promotions"."source_revision" IS NULL) AND ("memory_promotions"."source_document_id" IS NULL) = ("memory_promotions"."source_body_sha256" IS NULL)),
	CONSTRAINT "memory_promotions_sha256_check" CHECK ("memory_promotions"."released_body_sha256" ~ '^[0-9a-f]{64}$' AND ("memory_promotions"."source_body_sha256" IS NULL OR "memory_promotions"."source_body_sha256" ~ '^[0-9a-f]{64}$'))
);
--> statement-breakpoint
CREATE TABLE "memory_revisions" (
	"document_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"body_sha256" text NOT NULL,
	"scan_status" text DEFAULT 'unscanned' NOT NULL,
	"author_user_id" uuid,
	"author_session_id" uuid,
	"adopted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_revisions_pk" PRIMARY KEY("document_id","revision"),
	CONSTRAINT "memory_revisions_revision_check" CHECK ("memory_revisions"."revision" >= 1),
	CONSTRAINT "memory_revisions_title_check" CHECK (char_length("memory_revisions"."title") BETWEEN 1 AND 200),
	CONSTRAINT "memory_revisions_body_check" CHECK (octet_length("memory_revisions"."body") BETWEEN 1 AND 32768),
	CONSTRAINT "memory_revisions_body_sha256_check" CHECK ("memory_revisions"."body_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "memory_revisions_scan_status_check" CHECK ("memory_revisions"."scan_status" IN ('clean', 'quarantined', 'error', 'unscanned')),
	CONSTRAINT "memory_revisions_author_check" CHECK ("memory_revisions"."author_user_id" IS NOT NULL OR "memory_revisions"."author_session_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "memory_tombstones" (
	"document_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"deleted_by" uuid,
	"deleted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_tombstones_kind_check" CHECK ("memory_tombstones"."kind" IN ('normal', 'contaminated'))
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "personal_subjects" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_releaser_user_id_users_id_fk" FOREIGN KEY ("releaser_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_candidates" ADD CONSTRAINT "memory_candidates_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."memory_documents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_derivations" ADD CONSTRAINT "memory_derivations_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."memory_documents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_derivations" ADD CONSTRAINT "memory_derivations_derives_from_fk" FOREIGN KEY ("workspace_id","derives_from_id") REFERENCES "public"."memory_documents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_subject_user_id_users_id_fk" FOREIGN KEY ("subject_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_agent_fk" FOREIGN KEY ("workspace_id","agent_id") REFERENCES "public"."agents"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_documents" ADD CONSTRAINT "memory_documents_current_revision_fk" FOREIGN KEY ("id","current_revision") REFERENCES "public"."memory_revisions"("document_id","revision") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_promotions" ADD CONSTRAINT "memory_promotions_released_by_users_id_fk" FOREIGN KEY ("released_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_promotions" ADD CONSTRAINT "memory_promotions_adopted_by_users_id_fk" FOREIGN KEY ("adopted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_promotions" ADD CONSTRAINT "memory_promotions_target_document_fk" FOREIGN KEY ("workspace_id","target_document_id") REFERENCES "public"."memory_documents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_promotions" ADD CONSTRAINT "memory_promotions_target_revision_fk" FOREIGN KEY ("target_document_id","target_revision") REFERENCES "public"."memory_revisions"("document_id","revision") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_document_id_memory_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."memory_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_revisions" ADD CONSTRAINT "memory_revisions_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_tombstones" ADD CONSTRAINT "memory_tombstones_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memory_tombstones" ADD CONSTRAINT "memory_tombstones_document_fk" FOREIGN KEY ("workspace_id","document_id") REFERENCES "public"."memory_documents"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memory_derivations_derives_from_idx" ON "memory_derivations" USING btree ("derives_from_id");--> statement-breakpoint
CREATE INDEX "memory_promotions_target_idx" ON "memory_promotions" USING btree ("target_document_id");--> statement-breakpoint
-- A revision's content never changes; only its scan result, and its adoption
-- time once, are filled in later. A DELETE is refused unless it cascades from
-- its document's (pg_trigger_depth() is 1 for a statement's own trigger).
CREATE OR REPLACE FUNCTION "memory_revisions_immutable"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF pg_trigger_depth() > 1 THEN
      RETURN OLD;
    END IF;
  ELSIF (NEW."document_id", NEW."revision", NEW."title", NEW."body", NEW."body_sha256", NEW."author_user_id", NEW."author_session_id", NEW."created_at")
      IS NOT DISTINCT FROM (OLD."document_id", OLD."revision", OLD."title", OLD."body", OLD."body_sha256", OLD."author_user_id", OLD."author_session_id", OLD."created_at")
    AND (OLD."adopted_at" IS NULL OR NEW."adopted_at" IS NOT DISTINCT FROM OLD."adopted_at") THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'memory revision %/% is immutable', OLD."document_id", OLD."revision"
    USING ERRCODE = 'check_violation', CONSTRAINT = 'memory_revisions_immutable';
END;
$$;--> statement-breakpoint
CREATE TRIGGER "memory_revisions_immutable" BEFORE UPDATE OR DELETE ON "memory_revisions" FOR EACH ROW EXECUTE FUNCTION "memory_revisions_immutable"();