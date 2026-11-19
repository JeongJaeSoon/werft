import { z } from "zod";

import {
  agentIdSchema,
  memoryIdSchema,
  revisionSchema,
  sessionIdSchema,
  sha256HexSchema,
  timestampSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

/**
 * What a memory is about, which decides who reads it: one session's notes, one
 * person (`subject_user_id`), one agent's work, or the workspace's curated
 * knowledge, reached only by promotion (memory-layer.md §2).
 */
export const MEMORY_SCOPE_VALUES = [
  "session",
  "personal",
  "agent",
  "workspace",
] as const;
export const memoryScopeSchema = z.enum(MEMORY_SCOPE_VALUES);

/** A scope a caller may name; `space` is refused until shared spaces open. */
export const memoryScopeRequestSchema = z.enum([
  ...MEMORY_SCOPE_VALUES,
  "space",
]);

export const MEMORY_STATE_VALUES = [
  "candidate",
  "active",
  "quarantined",
  "superseded",
  "deleted",
] as const;
export const memoryStateSchema = z.enum(MEMORY_STATE_VALUES);

/** Only `clean` reaches search, injection or revision history (§9). */
export const MEMORY_SCAN_STATUS_VALUES = [
  "clean",
  "quarantined",
  "error",
  "unscanned",
] as const;
export const memoryScanStatusSchema = z.enum(MEMORY_SCAN_STATUS_VALUES);

/** `contaminated` also stops the sessions that saw the document (§9). */
export const MEMORY_TOMBSTONE_KIND_VALUES = ["normal", "contaminated"] as const;
export const memoryTombstoneKindSchema = z.enum(MEMORY_TOMBSTONE_KIND_VALUES);

export const MEMORY_REFUSAL_REASON_VALUES = [
  "requester_unresolved",
  "memory_forbidden",
  "memory_write_denied_by_surface",
  "access_policy_denied",
  "personal_memory_unavailable",
  "access_policy_unavailable",
  "space_scope_unavailable",
  "memory_revision_conflict",
  "idempotency_conflict",
  "memory_restoring",
] as const;
export const memoryRefusalReasonSchema = z.enum(MEMORY_REFUSAL_REASON_VALUES);

/** The operations whose per-document filter differs (§5 step 4). */
export const MEMORY_OPERATION_VALUES = [
  "retrieve",
  "candidate_queue",
  "revision_history",
  "quarantine_review",
] as const;
export const memoryOperationSchema = z.enum(MEMORY_OPERATION_VALUES);

export const MEMORY_TITLE_MAX_LENGTH = 200;
export const MEMORY_BODY_MAX_BYTES = 32 * 1024;
const utf8 = new TextEncoder();

const memoryDocumentShape = {
  id: memoryIdSchema,
  workspace_id: workspaceIdSchema,
  state: memoryStateSchema,
  /** The revision that is live; null while a candidate was never adopted. */
  current_revision: revisionSchema.nullable(),
  /** Every document this one derives from, roots included. */
  ancestor_ids: z.array(memoryIdSchema),
  /** People whose personal memory reached this document (taint, §4). */
  personal_subjects: z.array(userIdSchema),
  expires_at: timestampSchema.nullable(),
  created_at: timestampSchema,
};

const noScopeKeys = {
  session_id: z.null(),
  subject_user_id: z.null(),
  agent_id: z.null(),
};

/** Each scope fills exactly its own key and leaves the others null. */
export const memoryDocumentSchema = z.discriminatedUnion("scope", [
  z
    .object({
      ...memoryDocumentShape,
      ...noScopeKeys,
      scope: z.literal("session"),
      session_id: sessionIdSchema,
    })
    .strict(),
  z
    .object({
      ...memoryDocumentShape,
      ...noScopeKeys,
      scope: z.literal("personal"),
      subject_user_id: userIdSchema,
    })
    .strict(),
  z
    .object({
      ...memoryDocumentShape,
      ...noScopeKeys,
      scope: z.literal("agent"),
      agent_id: agentIdSchema,
    })
    .strict(),
  z
    .object({
      ...memoryDocumentShape,
      ...noScopeKeys,
      scope: z.literal("workspace"),
    })
    .strict(),
]);

/** A revision is never rewritten; an edit is the next revision. */
export const memoryRevisionSchema = z
  .object({
    document_id: memoryIdSchema,
    revision: revisionSchema,
    title: z.string().min(1).max(MEMORY_TITLE_MAX_LENGTH),
    body: z
      .string()
      .min(1)
      .refine((body) => utf8.encode(body).length <= MEMORY_BODY_MAX_BYTES, {
        message: `at most ${MEMORY_BODY_MAX_BYTES} bytes`,
      }),
    body_sha256: sha256HexSchema,
    scan_status: memoryScanStatusSchema,
    /** Null when a model wrote it from a session run. */
    author_user_id: userIdSchema.nullable(),
    author_session_id: sessionIdSchema.nullable(),
    /** Set once a person adopted this exact body; history shows only these. */
    adopted_at: timestampSchema.nullable(),
    created_at: timestampSchema,
  })
  .strict()
  .refine((r) => r.author_user_id !== null || r.author_session_id !== null, {
    message: "a revision names who wrote it",
  });

/**
 * The adoption request on a candidate document. The source's owner
 * (`releaser_user_id`) releases it first, deciding whether its content may
 * reach the wider target scope; then every person in the document's
 * `personal_subjects` must release it too (taint, §4). Only then may anyone
 * adopt it. An expired candidate leaves the queue.
 */
export const memoryCandidateSchema = z
  .object({
    document_id: memoryIdSchema,
    source_session_id: sessionIdSchema.nullable(),
    source_document_id: memoryIdSchema.nullable(),
    source_revision: revisionSchema.nullable(),
    releaser_user_id: userIdSchema,
    expires_at: timestampSchema,
    created_at: timestampSchema,
  })
  .strict()
  .refine(
    (c) =>
      (c.source_session_id === null || c.source_document_id === null) &&
      (c.source_document_id === null) === (c.source_revision === null),
    { message: "a candidate has at most one source, named whole" },
  );

/** One person's release of a candidate, naming the exact body released. */
export const memoryCandidateReleaseSchema = z
  .object({
    document_id: memoryIdSchema,
    user_id: userIdSchema,
    released_body_sha256: sha256HexSchema,
    released_at: timestampSchema,
  })
  .strict();

/**
 * Written in the adoption transaction: what was released, by whom, and the
 * exact body the adopter accepted. The source document is left as it was.
 */
export const memoryPromotionSchema = z
  .object({
    id: memoryIdSchema,
    workspace_id: workspaceIdSchema,
    target_document_id: memoryIdSchema,
    target_revision: revisionSchema,
    target_scope: memoryScopeSchema.exclude(["session"]),
    source_session_id: sessionIdSchema.nullable(),
    source_document_id: memoryIdSchema.nullable(),
    source_revision: revisionSchema.nullable(),
    source_body_sha256: sha256HexSchema.nullable(),
    released_body_sha256: sha256HexSchema,
    released_by: userIdSchema,
    released_at: timestampSchema,
    adopted_by: userIdSchema,
    adopted_at: timestampSchema,
  })
  .strict()
  .refine(
    (p) =>
      (p.source_session_id === null || p.source_document_id === null) &&
      (p.source_document_id === null) === (p.source_revision === null) &&
      (p.source_document_id === null) === (p.source_body_sha256 === null),
    { message: "a promotion has at most one source, named whole" },
  );

/** Committed with the deletion; from then on the document and its descendants are filtered out. */
export const memoryTombstoneSchema = z
  .object({
    document_id: memoryIdSchema,
    workspace_id: workspaceIdSchema,
    kind: memoryTombstoneKindSchema,
    deleted_by: userIdSchema.nullable(),
    deleted_at: timestampSchema,
  })
  .strict();

export type MemoryScope = z.infer<typeof memoryScopeSchema>;
export type MemoryScopeRequest = z.infer<typeof memoryScopeRequestSchema>;
export type MemoryState = z.infer<typeof memoryStateSchema>;
export type MemoryScanStatus = z.infer<typeof memoryScanStatusSchema>;
export type MemoryTombstoneKind = z.infer<typeof memoryTombstoneKindSchema>;
export type MemoryRefusalReason = z.infer<typeof memoryRefusalReasonSchema>;
export type MemoryOperation = z.infer<typeof memoryOperationSchema>;
export type MemoryDocument = z.infer<typeof memoryDocumentSchema>;
export type MemoryRevision = z.infer<typeof memoryRevisionSchema>;
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export type MemoryCandidateRelease = z.infer<
  typeof memoryCandidateReleaseSchema
>;
export type MemoryPromotion = z.infer<typeof memoryPromotionSchema>;
export type MemoryTombstone = z.infer<typeof memoryTombstoneSchema>;

export function resolveMemoryScope(
  requested: MemoryScopeRequest,
):
  | { ok: true; scope: MemoryScope }
  | { ok: false; reason: "space_scope_unavailable" } {
  return requested === "space"
    ? { ok: false, reason: "space_scope_unavailable" }
    : { ok: true, scope: requested };
}
