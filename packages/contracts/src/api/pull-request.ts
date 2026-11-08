import { z } from "zod";

import {
  receiptIdSchema,
  sessionIdSchema,
  timestampSchema,
} from "../shared/index.ts";
import { pushReasonCodeSchema, pushRequestIdSchema } from "./push-request.ts";

/** The pull request the platform opened from a pushed push request. */
export const pullRequestSchema = z.object({
  push_request_id: pushRequestIdSchema,
  session_id: sessionIdSchema,
  repository_id: z.string().min(1),
  number: z.number().int().positive(),
  url: z.url(),
  head: z.string().min(1),
  base: z.string().min(1),
  created_at: timestampSchema,
  // The `open_pull_request` receipt of the call that recorded it.
  receipt_id: receiptIdSchema,
});

export const PULL_REQUEST_TITLE_REQUEST_MAX = 1000;
export const PULL_REQUEST_TEXT_REQUEST_MAX = 60_000;

export const PULL_REQUEST_FIELD_TEXT_MAX = 8000;
export const PULL_REQUEST_CHANGES_MAX = 50;
export const PULL_REQUEST_CHANGE_TEXT_MAX = 1000;
export const PULL_REQUEST_RELATED_MAX = 20;

/** One issue the pull request relates to; the platform writes the reference. */
export const relatedIssueSchema = z
  .object({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    // Omitted: the pull request's own repository.
    repository_id: z.string().min(1).max(128).optional(),
    // Only an issue of the pull request's own repository is closed on merge.
    // Left out is false; optional rather than defaulted so a client's input
    // type does not require it.
    closes: z.boolean().optional(),
  })
  .strict();
export type RelatedIssue = z.infer<typeof relatedIssueSchema>;

/**
 * The content the agent gives; the platform lays it out. `body` is the
 * legacy free-text form and excludes the structured fields.
 */
export const PULL_REQUEST_STRUCTURED_FIELDS = [
  "summary",
  "changes",
  "rationale",
  "testing",
  "notes",
  "related",
] as const;
export type PullRequestStructuredField =
  (typeof PULL_REQUEST_STRUCTURED_FIELDS)[number];

const pullRequestContentShape = {
  title: z
    .string()
    .trim()
    .min(1)
    .max(PULL_REQUEST_TITLE_REQUEST_MAX)
    .optional(),
  summary: z.string().max(PULL_REQUEST_FIELD_TEXT_MAX).optional(),
  changes: z
    .array(z.string().min(1).max(PULL_REQUEST_CHANGE_TEXT_MAX))
    .max(PULL_REQUEST_CHANGES_MAX)
    .optional(),
  rationale: z.string().max(PULL_REQUEST_FIELD_TEXT_MAX).optional(),
  testing: z.string().max(PULL_REQUEST_FIELD_TEXT_MAX).optional(),
  notes: z.string().max(PULL_REQUEST_FIELD_TEXT_MAX).optional(),
  related: z.array(relatedIssueSchema).max(PULL_REQUEST_RELATED_MAX).optional(),
  // Legacy: the whole body as text.
  body: z.string().max(PULL_REQUEST_TEXT_REQUEST_MAX).optional(),
};

type PullRequestContentInput = {
  body?: string | undefined;
  summary?: string | undefined;
  changes?: readonly string[] | undefined;
  rationale?: string | undefined;
  testing?: string | undefined;
  notes?: string | undefined;
  related?: readonly RelatedIssue[] | undefined;
};

/** Whether any structured field is present. */
export function hasStructuredFields(value: PullRequestContentInput): boolean {
  return PULL_REQUEST_STRUCTURED_FIELDS.some(
    (field) => value[field] !== undefined,
  );
}

/** Field strings add up to at most the legacy body's limit (GitHub's is 65,536). */
export function structuredFieldsLength(value: PullRequestContentInput): number {
  return (
    (value.summary?.length ?? 0) +
    (value.rationale?.length ?? 0) +
    (value.testing?.length ?? 0) +
    (value.notes?.length ?? 0) +
    (value.changes?.reduce((sum, change) => sum + change.length, 0) ?? 0)
  );
}

function checkContent(value: PullRequestContentInput, ctx: z.RefinementCtx) {
  if (value.body !== undefined && hasStructuredFields(value)) {
    ctx.addIssue({
      code: "custom",
      message: "Give body or the structured fields, not both",
      path: ["body"],
    });
  }
  if (structuredFieldsLength(value) > PULL_REQUEST_TEXT_REQUEST_MAX) {
    ctx.addIssue({
      code: "custom",
      message: `The fields add up to more than ${PULL_REQUEST_TEXT_REQUEST_MAX} characters`,
    });
  }
}

export const pullRequestContentSchema = z
  .object(pullRequestContentShape)
  .strict()
  .superRefine(checkContent);

export const openPullRequestRequestSchema = pullRequestContentSchema;

// What the session's agent may change on a pull request it opened: the
// platform's tail stays in the body either way. Structured fields replace the
// whole body (a field left out is empty); a title alone leaves the body.
export const updatePullRequestRequestSchema = z
  .object(pullRequestContentShape)
  .strict()
  .superRefine(checkContent)
  .refine(
    (value) =>
      value.title !== undefined ||
      value.body !== undefined ||
      hasStructuredFields(value),
    { message: "Give a title, a body, structured fields or a mix" },
  );

/**
 * Where the body the platform wrote came from: `agent` is the legacy `body`
 * as written, `platform` the default template. `repository` and `workspace`
 * name a template from the repository or workspace settings, with its path
 * (`skipped` says why one was passed over).
 */
export const PULL_REQUEST_BODY_SOURCE_KINDS = [
  "repository",
  "workspace",
  "agent",
  "platform",
] as const;
/**
 * Why a repository's template was passed over for the platform's default.
 * `unbalanced_comment` also covers markup the platform cannot put text around
 * safely, such as an HTML tag split over lines.
 */
export const PULL_REQUEST_TEMPLATE_SKIP_VALUES = [
  "too_large",
  "not_file",
  "not_utf8",
  "unbalanced_comment",
  "multiple",
  "read_failed",
] as const;

/**
 * Which template a rendering used, for the receipt: the default branch's
 * commit the repository was read at (null when that read failed), and the
 * path and blob when one was used or the reason it was skipped. Never the
 * template's text.
 */
export const pullRequestTemplateRecordSchema = z.object({
  commit: z.string().nullable(),
  path: z.string().optional(),
  blob_sha: z.string().optional(),
  skipped: z.enum(PULL_REQUEST_TEMPLATE_SKIP_VALUES).optional(),
});
export type PullRequestTemplateRecord = z.infer<
  typeof pullRequestTemplateRecordSchema
>;

export const pullRequestBodySourceSchema = z.object({
  kind: z.enum(PULL_REQUEST_BODY_SOURCE_KINDS),
  path: z.string().optional(),
  skipped: z.string().optional(),
  // `related` items the platform left out: another repository the session
  // does not have, or one it cannot name.
  related_dropped: z.number().int().nonnegative().optional(),
});
export type PullRequestBodySource = z.infer<typeof pullRequestBodySourceSchema>;

export const PULL_REQUEST_COMMENT_MARKER_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const DEFAULT_PULL_REQUEST_COMMENT_MARKER = "status";

export const commentPullRequestRequestSchema = z
  .object({
    body: z.string().trim().min(1).max(PULL_REQUEST_TEXT_REQUEST_MAX),
    // One comment per marker: posting the same marker again edits it.
    marker: z.string().regex(PULL_REQUEST_COMMENT_MARKER_PATTERN).optional(),
  })
  .strict();

export const PULL_REQUEST_STATE_VALUES = ["open", "closed"] as const;
export const pullRequestStateSchema = z.enum(PULL_REQUEST_STATE_VALUES);

export const setPullRequestStateResponseSchema = z.object({
  pull_request: pullRequestSchema,
  state: pullRequestStateSchema,
  // False when the pull request was already in that state.
  changed: z.boolean(),
  receipt_id: receiptIdSchema,
});

/** What `merge_pull_request` answers. */
export const mergePullRequestResponseSchema = z.object({
  pull_request: pullRequestSchema,
  merged: z.literal(true),
  // False when the pull request was already merged on the pushed commit.
  changed: z.boolean(),
  head_sha: z.string(),
  merge_commit_sha: z.string().nullable(),
  // Null when this call did not merge it itself.
  method: z.literal("squash").nullable(),
  receipt_id: receiptIdSchema,
});

export const openPullRequestResponseSchema = z.object({
  pull_request: pullRequestSchema,
  // False when the pull request was already open (or recorded) and this
  // call only answered it.
  created: z.boolean(),
  // Null when this call wrote no body (the pull request was already open).
  body_source: pullRequestBodySourceSchema.nullable(),
  receipt_id: receiptIdSchema,
});

/**
 * The answer to `?schedule=true` (and to the MCP call with a push intent id)
 * while the pull request is not open yet: the platform holds the content and
 * opens the pull request once the push finishes. At least one id is set.
 */
export const scheduledPullRequestResponseSchema = z
  .object({
    status: z.literal("scheduled"),
    // Set once the intent became a push request, or when called with one.
    push_request_id: pushRequestIdSchema.nullable(),
    // Set while the intent has no push request, or when called with one.
    push_intent_id: z.uuid().nullable(),
    receipt_id: receiptIdSchema,
  })
  .refine((r) => r.push_request_id !== null || r.push_intent_id !== null, {
    message: "a scheduled answer names a push request or a push intent",
  });

/** What `openPullRequest` answers: the opened pull request, or a schedule. */
export const openPullRequestResultSchema = z.union([
  openPullRequestResponseSchema,
  scheduledPullRequestResponseSchema,
]);

/** `?schedule=true`: strictly the string `true`, or absent. */
export const openPullRequestQuerySchema = z
  .object({ schedule: z.literal("true").optional() })
  .strict();

export const pullRequestCommentSchema = z.object({
  id: z.number().int().positive(),
  url: z.url(),
  marker: z.string(),
  created: z.boolean(),
});

export const updatePullRequestResponseSchema = z.object({
  pull_request: pullRequestSchema,
  // Null when the call left the body as it was (a title only).
  body_source: pullRequestBodySourceSchema.nullable(),
  receipt_id: receiptIdSchema,
});

export const commentPullRequestResponseSchema = z.object({
  pull_request: pullRequestSchema,
  comment: pullRequestCommentSchema,
  receipt_id: receiptIdSchema,
});

// Why opening or commenting on a pull request was refused, as its receipt
// and error details say.
export const PULL_REQUEST_REFUSAL_VALUES = [
  "missing_scope",
  "unverified_principal",
  "not_found",
  "not_pushed",
  "catalog_changed",
  "no_forge",
  "no_pull_request",
  "forge_failed",
  "github_settings_unsupported",
  // The GitHub gate refused the token; `reason_code` says why.
  "github_refused",
  // Closing or reopening a pull request that was merged.
  "pull_request_merged",
  // A later push request to the same target exists; attach the content there.
  "superseded",
  // The push intent ended (failed or cancelled) before it became a request.
  "intent_ended",
  // The branch's open pull request is on another commit than the pushed one.
  "head_moved",
  // Merging: GitHub will not merge it now (checks, reviews, conflicts, draft).
  "merge_blocked",
  "pull_request_closed",
] as const;
export const pullRequestRefusalSchema = z.enum(PULL_REQUEST_REFUSAL_VALUES);

/**
 * `result` of an `open_pull_request`, `update_pull_request`,
 * `comment_pull_request`, `close_pull_request` or `reopen_pull_request`
 * receipt. Fields the attempt never learned are null.
 */
export const pullRequestReceiptResultSchema = z.object({
  push_request_id: pushRequestIdSchema.nullable(),
  verdict: z.enum(["allow", "refuse"]),
  refusal: pullRequestRefusalSchema.nullable(),
  repository_id: z.string().nullable(),
  number: z.number().int().nullable(),
  url: z.string().nullable(),
  head: z.string().nullable(),
  base: z.string().nullable(),
  created: z.boolean().nullable(),
  // A comment receipt only.
  comment_id: z.number().int().nullable().optional(),
  comment_url: z.string().nullable().optional(),
  marker: z.string().nullable().optional(),
  reason_code: pushReasonCodeSchema.nullable().optional(),
  // A close or reopen receipt only: the state after the call, and whether
  // this call changed it.
  state: pullRequestStateSchema.nullable().optional(),
  changed: z.boolean().nullable().optional(),
  // A merge receipt only.
  merged: z.boolean().nullable().optional(),
  head_sha: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  method: z.literal("squash").nullable().optional(),
  // An open or update receipt whose body came from structured fields.
  template: pullRequestTemplateRecordSchema.optional(),
});

export type ScheduledPullRequestResponse = z.infer<
  typeof scheduledPullRequestResponseSchema
>;
export type OpenPullRequestResult = z.infer<typeof openPullRequestResultSchema>;
export type PullRequest = z.infer<typeof pullRequestSchema>;
export type OpenPullRequestRequest = z.infer<
  typeof openPullRequestRequestSchema
>;
export type UpdatePullRequestRequest = z.infer<
  typeof updatePullRequestRequestSchema
>;
export type UpdatePullRequestResponse = z.infer<
  typeof updatePullRequestResponseSchema
>;
export type CommentPullRequestRequest = z.infer<
  typeof commentPullRequestRequestSchema
>;
export type OpenPullRequestResponse = z.infer<
  typeof openPullRequestResponseSchema
>;
export type CommentPullRequestResponse = z.infer<
  typeof commentPullRequestResponseSchema
>;
export type PullRequestState = z.infer<typeof pullRequestStateSchema>;
export type MergePullRequestResponse = z.infer<
  typeof mergePullRequestResponseSchema
>;
export type SetPullRequestStateResponse = z.infer<
  typeof setPullRequestStateResponseSchema
>;
export type PullRequestRefusal = z.infer<typeof pullRequestRefusalSchema>;
export type PullRequestReceiptResult = z.infer<
  typeof pullRequestReceiptResultSchema
>;
