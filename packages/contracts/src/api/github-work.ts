import { z } from "zod";

import { receiptIdSchema, sessionIdParamsSchema } from "../shared/index.ts";

/** A file under `.github/workflows/`, as an allow-list entry names it. */
export const githubWorkflowFileSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+\.ya?ml$/);

/** A branch name; GitHub receives it as `refs/heads/<ref>`. */
export const githubBranchSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!refs\/)(?!\/)(?!.*\/\/)(?!.*\.\.)[^\s~^:?*[\\]+(?<![/.])$/)
  .refine(
    (ref) =>
      [...ref].every((char) => {
        const code = char.charCodeAt(0);
        return code >= 0x20 && code !== 0x7f;
      }),
    { message: "control characters are not allowed" },
  );

export const GITHUB_DISPATCH_INPUTS_MAX = 25;

export const dispatchWorkflowRequestSchema = z
  .object({
    workflow: githubWorkflowFileSchema,
    ref: githubBranchSchema,
    // Passed to GitHub as they are; never kept in a receipt or a log.
    inputs: z
      .record(z.string().min(1).max(100), z.string().max(65_536))
      .refine(
        (inputs) => Object.keys(inputs).length <= GITHUB_DISPATCH_INPUTS_MAX,
        { message: `at most ${GITHUB_DISPATCH_INPUTS_MAX} inputs` },
      )
      .optional(),
  })
  .strict();

export const githubWorkflowRunRefSchema = z.object({
  id: z.number().int().positive(),
  html_url: z.url(),
});

/** `run` is null when GitHub named no run for the dispatch. */
export const dispatchWorkflowResponseSchema = z.object({
  receipt_id: receiptIdSchema,
  run: githubWorkflowRunRefSchema.nullable(),
});

export const workflowRunParamsSchema = sessionIdParamsSchema.extend({
  run_id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const githubWorkflowRunSchema = z.object({
  id: z.number().int().positive(),
  path: z.string(),
  head_branch: z.string().nullable(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  html_url: z.url(),
});

/** One check run or workflow run GitHub holds for a commit. */
export const githubCiRunSchema = z.object({
  name: z.string(),
  status: z.string().nullable(),
  conclusion: z.string().nullable(),
  html_url: z.url().nullable(),
});

/**
 * The CI of one commit: its check runs and workflow runs, the first page of
 * each; `truncated` when GitHub holds more.
 */
export const githubCiStatusSchema = z.object({
  head_sha: z.string().regex(/^[0-9a-f]{40}$/),
  pull_request_number: z.number().int().positive().nullable(),
  check_runs: z.array(githubCiRunSchema),
  workflow_runs: z.array(
    githubCiRunSchema.safeExtend({ id: z.number().int().positive() }),
  ),
  truncated: z.boolean(),
});

export const rerunWorkflowRequestSchema = z
  .object({ failed_only: z.boolean().optional() })
  .strict();

export const rerunWorkflowResponseSchema = z.object({
  receipt_id: receiptIdSchema,
});

/** How the session was started, as the pull request's tail names it. */
export const SESSION_TRIGGER_VALUES = [
  "web",
  "slack",
  "personal_key",
  "agent_key",
  "operator_key",
] as const;
export const sessionTriggerSchema = z.enum(SESSION_TRIGGER_VALUES);

/**
 * Whose name the session's commits carry besides the App's. `co_author`:
 * the person who started it linked GitHub. `unlinked`: they did not.
 * `app_only`: no person started it (an agent or operator key).
 */
export const GITHUB_ATTRIBUTION_VALUES = [
  "co_author",
  "unlinked",
  "app_only",
] as const;

export const sessionGitHubAttributionSchema = z
  .object({
    trigger: sessionTriggerSchema,
    attribution: z.enum(GITHUB_ATTRIBUTION_VALUES),
    /** The linked GitHub login; null unless `co_author`. */
    login: z.string().min(1).max(39).nullable(),
  })
  .strict();

export type SessionTrigger = z.infer<typeof sessionTriggerSchema>;
export type SessionGitHubAttribution = z.infer<
  typeof sessionGitHubAttributionSchema
>;

export const GITHUB_REVIEW_EVENT_VALUES = [
  "APPROVE",
  "REQUEST_CHANGES",
  "COMMENT",
] as const;
export const GITHUB_REVIEW_BODY_MAX_LENGTH = 65_536;

export const pullRequestReviewParamsSchema = sessionIdParamsSchema.extend({
  number: z.coerce.number().int().positive().max(2_147_483_647),
});

export const submitPullRequestReviewRequestSchema = z
  .object({
    event: z.enum(GITHUB_REVIEW_EVENT_VALUES),
    // The head the caller read: GitHub files the review on this commit, so
    // nothing pushed after the read is approved.
    commit_id: z.string().regex(/^[0-9a-f]{40}$/),
    // Sent to GitHub only; never kept in a receipt or a log.
    body: z.string().min(1).max(GITHUB_REVIEW_BODY_MAX_LENGTH).optional(),
  })
  .strict()
  .refine((review) => review.event === "APPROVE" || review.body !== undefined, {
    message: "body is required unless event is APPROVE",
    path: ["body"],
  });

export const submitPullRequestReviewResponseSchema = z.object({
  receipt_id: receiptIdSchema,
  review: z.object({
    id: z.number().int().positive(),
    html_url: z.url(),
  }),
});

export type GitHubReviewEvent = (typeof GITHUB_REVIEW_EVENT_VALUES)[number];
export type SubmitPullRequestReviewRequest = z.infer<
  typeof submitPullRequestReviewRequestSchema
>;
export type SubmitPullRequestReviewResponse = z.infer<
  typeof submitPullRequestReviewResponseSchema
>;
export type DispatchWorkflowRequest = z.infer<
  typeof dispatchWorkflowRequestSchema
>;
export type DispatchWorkflowResponse = z.infer<
  typeof dispatchWorkflowResponseSchema
>;
export type GitHubWorkflowRunView = z.infer<typeof githubWorkflowRunSchema>;
export type GitHubCiRun = z.infer<typeof githubCiRunSchema>;
export type GitHubCiStatusView = z.infer<typeof githubCiStatusSchema>;
export type RerunWorkflowRequest = z.infer<typeof rerunWorkflowRequestSchema>;
export type RerunWorkflowResponse = z.infer<typeof rerunWorkflowResponseSchema>;
