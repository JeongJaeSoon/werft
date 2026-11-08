import { z } from "zod";

import {
  githubPurposeSchema,
  githubRefusalSchema,
} from "../musterrolle/github-settings.ts";
import { receiptIdSchema, timestampSchema } from "../shared/index.ts";
import { GITHUB_REVIEW_EVENT_VALUES } from "./github-work.ts";

/**
 * What a session made, by kind (design github-agent.md §10). Only the server
 * writes an outcome; a type is added by a migration widening the table's
 * CHECK together with its states here.
 */
export const SESSION_OUTCOME_TYPE_VALUES = [
  "github_pull_request",
  "github_review",
] as const;

export const GITHUB_PULL_REQUEST_OUTCOME_STATE_VALUES = [
  "open",
  "merged",
  "closed",
] as const;

/** A review is recorded once, when GitHub took it; it is not read again. */
export const GITHUB_REVIEW_OUTCOME_STATE_VALUES = ["submitted"] as const;

/** The most of a pull request's title an outcome keeps (achievement-rules.md §3). */
export const PULL_REQUEST_OUTCOME_TITLE_MAX_LENGTH = 200;

/** Why the last read of an outcome's state failed; its state is left as it was. */
export const SESSION_OUTCOME_CHECK_ERROR_VALUES = [
  "not_found",
  "forge_failed",
  "github_refused",
] as const;

export const sessionOutcomeTypeSchema = z.enum(SESSION_OUTCOME_TYPE_VALUES);
export const sessionOutcomeCheckErrorSchema = z.enum(
  SESSION_OUTCOME_CHECK_ERROR_VALUES,
);

/**
 * A pull request outcome's metadata. `adopted` is true when the platform
 * answered a pull request it did not create (one already open for the
 * session's branch), null when that is unknown (a row filled in later). The
 * size fields are null until the first read of the pull request.
 */
export const githubPullRequestOutcomeMetadataSchema = z.object({
  // Null on a row written before titles were kept, until its next read;
  // one merged by then is never read again and stays null.
  title: z.string().max(PULL_REQUEST_OUTCOME_TITLE_MAX_LENGTH).nullable(),
  head: z.string(),
  base: z.string(),
  adopted: z.boolean().nullable(),
  merge_commit_sha: z.string().nullable(),
  additions: z.number().int().nonnegative().nullable(),
  deletions: z.number().int().nonnegative().nullable(),
  changed_files: z.number().int().nonnegative().nullable(),
  commits: z.number().int().nonnegative().nullable(),
});

/**
 * A review outcome's metadata: the pull request it reviewed and the session
 * that opened it (null for one the platform did not open). Never the body.
 */
export const githubReviewOutcomeMetadataSchema = z.object({
  number: z.number().int().positive(),
  event: z.enum(GITHUB_REVIEW_EVENT_VALUES),
  commit_id: z.string(),
  opened_by_session_id: z.uuid().nullable(),
});

const outcomeFields = {
  id: z.uuid(),
  url: z.url(),
  repository_id: z.string().nullable(),
  external_id: z.string().nullable(),
  state_changed_at: timestampSchema,
  merged_at: timestampSchema.nullable(),
  closed_at: timestampSchema.nullable(),
  // When the platform last had GitHub's answer; the state is as of then.
  state_checked_at: timestampSchema.nullable(),
  check_error: sessionOutcomeCheckErrorSchema.nullable(),
  created_at: timestampSchema,
};

export const sessionOutcomeSchema = z.discriminatedUnion("type", [
  z.object({
    ...outcomeFields,
    type: z.literal("github_pull_request"),
    state: z.enum(GITHUB_PULL_REQUEST_OUTCOME_STATE_VALUES),
    metadata: githubPullRequestOutcomeMetadataSchema,
  }),
  z.object({
    ...outcomeFields,
    type: z.literal("github_review"),
    state: z.enum(GITHUB_REVIEW_OUTCOME_STATE_VALUES),
    metadata: githubReviewOutcomeMetadataSchema,
  }),
]);

/** GET /v1/sessions/{id}/outcomes: oldest first. */
export const listSessionOutcomesResponseSchema = z.object({
  items: z.array(sessionOutcomeSchema),
});

/** The most refusals GET /v1/sessions/{id}/github/refusals lists. */
export const SESSION_GITHUB_REFUSALS_LIMIT = 10;

/** One refusal of the GitHub gate for the session, as its receipt names it. */
export const sessionGitHubRefusalSchema = z.object({
  receipt_id: receiptIdSchema,
  operation: z.enum([
    "mint_github_token",
    "dispatch_workflow",
    "rerun_workflow",
    "review_pull_request",
    "merge_pull_request",
  ]),
  purpose: githubPurposeSchema,
  reason_code: githubRefusalSchema,
  created_at: timestampSchema,
});

/** GET /v1/sessions/{id}/github/refusals: newest first. */
export const listSessionGitHubRefusalsResponseSchema = z.object({
  items: z.array(sessionGitHubRefusalSchema),
});

export type SessionOutcomeType = (typeof SESSION_OUTCOME_TYPE_VALUES)[number];
export type GitHubPullRequestOutcomeState =
  (typeof GITHUB_PULL_REQUEST_OUTCOME_STATE_VALUES)[number];
export type SessionOutcomeCheckError =
  (typeof SESSION_OUTCOME_CHECK_ERROR_VALUES)[number];
export type GitHubPullRequestOutcomeMetadata = z.infer<
  typeof githubPullRequestOutcomeMetadataSchema
>;
export type GitHubReviewOutcomeMetadata = z.infer<
  typeof githubReviewOutcomeMetadataSchema
>;
export type SessionOutcome = z.infer<typeof sessionOutcomeSchema>;
export type ListSessionOutcomesResponse = z.infer<
  typeof listSessionOutcomesResponseSchema
>;
export type SessionGitHubRefusal = z.infer<typeof sessionGitHubRefusalSchema>;
export type ListSessionGitHubRefusalsResponse = z.infer<
  typeof listSessionGitHubRefusalsResponseSchema
>;
