import { z } from "zod";

import { admissionStateSchema, sessionStatusSchema } from "../api/session.ts";
import {
  agentIdSchema,
  agentReleaseIdSchema,
  revisionSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

// The title is capped twice: code points keep it one line in the list, bytes
// keep it inside the column. Korean hits the byte cap long before the other.
export const DIGEST_TITLE_MAX_CODE_POINTS = 120;
export const DIGEST_TITLE_MAX_BYTES = 480;
export const DIGEST_SUMMARY_MAX_CODE_POINTS = 600;
export const DIGEST_SUMMARY_MAX_BYTES = 2 * 1024;

const utf8 = new TextEncoder();

function boundedText(maxCodePoints: number, maxBytes: number) {
  return z
    .string()
    .refine(
      (value) => [...value].length <= maxCodePoints,
      `Exceeds ${maxCodePoints} code points`,
    )
    .refine(
      (value) => utf8.encode(value).length <= maxBytes,
      `Exceeds ${maxBytes} UTF-8 bytes`,
    );
}

// A title always says something: dispatch generates one and a person can
// rename it, but neither produces a blank. An empty summary is different —
// it is what an unsummarized session honestly has.
export const digestTitleSchema = boundedText(
  DIGEST_TITLE_MAX_CODE_POINTS,
  DIGEST_TITLE_MAX_BYTES,
).min(1);
export const digestSummarySchema = boundedText(
  DIGEST_SUMMARY_MAX_CODE_POINTS,
  DIGEST_SUMMARY_MAX_BYTES,
);

/** Why a session is waiting on a person, or null when it is not. */
export const DIGEST_WAITING_REASON_VALUES = ["permission", "question"] as const;
export const digestWaitingReasonSchema = z.enum(DIGEST_WAITING_REASON_VALUES);

/** Money is stored as numeric and travels as a decimal string, never a float. */
export const costUsdSchema = z.string().regex(/^\d+(\.\d+)?$/);

/**
 * Layer 1 of three: the `session_digests` row.
 *
 * Nothing reads or writes the row yet. Dispatch candidate search and the Slack
 * thread summary are its planned readers.
 */
const sessionDigestRowSchema = z
  .object({
    session_id: sessionIdSchema,
    workspace_id: workspaceIdSchema,
    agent_id: agentIdSchema.nullable(),
    agent_release_id: agentReleaseIdSchema.nullable(),
    title: digestTitleSchema,
    /** Set when a person renames the session; the summarizer stops touching it. */
    title_locked: z.boolean(),
    summary: digestSummarySchema,
    admission_state: admissionStateSchema,
    status: sessionStatusSchema,
    last_turn_state: z.string().min(1).nullable(),
    waiting_reason: digestWaitingReasonSchema.nullable(),
    last_activity_at: timestampSchema,
    turn_count: z.number().int().nonnegative(),
    cost_usd: costUsdSchema,
    /** `surface:channel:thread` of the conversation this started in. */
    source_thread: z.string().min(1).max(256).nullable(),
    revision: revisionSchema,
    /** The session revision this row was projected from; a lower one is stale. */
    source_session_revision: revisionSchema,
    /** Last turn the async summarizer covered; null before it has ever run. */
    summarized_turn_sequence: revisionSchema.nullable(),
    last_summarized_turn_id: turnIdSchema.nullable(),
    updated_at: timestampSchema,
  })
  .strict();

export const sessionDigestSchema = sessionDigestRowSchema.superRefine(
  (digest, ctx) => {
    // Both describe one summarizer checkpoint. Half of it would let one
    // consumer read "never summarized" and another read a covered turn.
    if (
      (digest.summarized_turn_sequence === null) !==
      (digest.last_summarized_turn_id === null)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["last_summarized_turn_id"],
        message: "the summarizer checkpoint is both fields or neither",
      });
    }
  },
);

/** Layer 2: what `GET /v1/sessions` returns. Layer 3 (`SessionSummaryV1`, the
 * summarizer's own output) belongs to I4 and is not fixed here. */
export const sessionDigestViewSchema = sessionDigestRowSchema
  .omit({
    source_session_revision: true,
    summarized_turn_sequence: true,
    last_summarized_turn_id: true,
  })
  .extend({ unread: z.boolean() });

export type DigestWaitingReason = z.infer<typeof digestWaitingReasonSchema>;
export type SessionDigest = z.infer<typeof sessionDigestSchema>;
export type SessionDigestView = z.infer<typeof sessionDigestViewSchema>;
