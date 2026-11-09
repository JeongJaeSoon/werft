import { z } from "zod";

import { GITHUB_POLICY_SOURCE_VALUES } from "../kollegium/agents.ts";
import { deciderKeySchema } from "../musterrolle/api-keys.ts";
import { receiptActorSchema } from "../musterrolle/authorization.ts";
import { githubRefusalSchema } from "../musterrolle/github-settings.ts";
import {
  agentReleaseIdSchema,
  receiptIdSchema,
  revisionSchema,
  sessionIdParamsSchema,
  sessionIdSchema,
  timestampSchema,
} from "../shared/index.ts";
import { githubPolicyReceiptFieldsSchema } from "./receipt.ts";

// requested → approved | rejected is a human decision; approved → pushing →
// pushed | failed is the platform's push. Only a policy's approval the agent's
// settings no longer give goes back to `requested`, before it is pushed.
export const PUSH_REQUEST_STATE_VALUES = [
  "requested",
  "approved",
  "rejected",
  "pushing",
  "pushed",
  "failed",
] as const;
export const pushRequestStateSchema = z.enum(PUSH_REQUEST_STATE_VALUES);

/** States that keep a session from opening another request. */
export const OPEN_PUSH_REQUEST_STATES = [
  "requested",
  "approved",
  "pushing",
] as const satisfies readonly PushRequestState[];

/**
 * Where a push request came from: `direct` is a REST call or the legacy MCP
 * path (it pins the session's latest checkpoint); `intent` is made by the
 * intent runner from a revision a finished turn pinned.
 */
export const PUSH_REQUEST_ORIGIN_VALUES = ["direct", "intent"] as const;
export const pushRequestOriginSchema = z.enum(PUSH_REQUEST_ORIGIN_VALUES);
export type PushRequestOrigin = z.infer<typeof pushRequestOriginSchema>;

/**
 * The flow a request was made under, fixed at creation. Only `legacy` rows
 * get the Slack follow-up turn; the install setting never decides it later.
 */
export const PUSH_REQUEST_FLOW_VALUES = ["legacy", "actions"] as const;
export const pushRequestFlowSchema = z.enum(PUSH_REQUEST_FLOW_VALUES);
export type PushRequestFlow = z.infer<typeof pushRequestFlowSchema>;

/**
 * The pull-request stage of a push request that carries a pull request
 * intent. Null while there is none. The values are written by the PR drain;
 * this layer only reads `due` and `opening` to keep a later push for the
 * same target waiting.
 */
export const PULL_REQUEST_STAGE_VALUES = [
  "due",
  "opening",
  "opened",
  "closed_unrecorded",
  "uncertain",
  "failed",
  "cancelled",
] as const;
export const pullRequestStageSchema = z.enum(PULL_REQUEST_STAGE_VALUES);
export type PullRequestStage = z.infer<typeof pullRequestStageSchema>;

/** Stages that keep another push to the same target from being made. */
export const OPEN_PULL_REQUEST_STAGES = [
  "due",
  "opening",
] as const satisfies readonly PullRequestStage[];

/**
 * deferred: asked for inside a running turn, waiting for the turn to end.
 * pinned: the turn ended with a checkpoint; the revision is kept for it.
 * requested: the push request exists (its own state says what happens next).
 * failed / cancelled: ended without a push request, `refusal_code` says why.
 */
export const PUSH_INTENT_STATUS_VALUES = [
  "deferred",
  "pinned",
  "requested",
  "failed",
  "cancelled",
] as const;
export const pushIntentStatusSchema = z.enum(PUSH_INTENT_STATUS_VALUES);
export type PushIntentStatus = z.infer<typeof pushIntentStatusSchema>;

/** Codes an intent ends with; the runner and finalize are the only writers. */
export const PUSH_INTENT_REFUSAL_VALUES = [
  "turn_ended_without_checkpoint",
  "turn_finalized_without_pin",
  "superseded_by_turn",
  "session_closed",
  "rejected_before",
  "request_open",
  "github_disabled",
  "over_workspace_ceiling",
  "repository_not_allowed",
  "checkpoint_unavailable",
  "source_missing",
  "attribution_mismatch",
  "uncommitted_changes",
  "pinned_source_invalid",
] as const;
export const pushIntentRefusalSchema = z.enum(PUSH_INTENT_REFUSAL_VALUES);
export type PushIntentRefusal = z.infer<typeof pushIntentRefusalSchema>;

/** What the web and `listPushRequests` show of an intent. */
export const pushIntentSchema = z.object({
  id: z.uuid(),
  session_id: sessionIdSchema,
  repository_id: z.string().min(1),
  target_branch: z.string().min(1),
  status: pushIntentStatusSchema,
  refusal_code: pushIntentRefusalSchema.nullable(),
  push_request_id: z.uuid().nullable(),
  // The local branch the push carries; null is the snapshot of the turn end.
  source_ref: z.string().nullable().default(null),
  created_at: timestampSchema,
});
export type PushIntent = z.infer<typeof pushIntentSchema>;

/**
 * A local branch of the session's workspace, by short name (`guard-docs`, not
 * `refs/heads/guard-docs`): the source a push carries. A subset of what git
 * accepts, within what a checkpoint records (200 characters).
 */
export const sourceRefSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(
    (name) =>
      !name.includes("..") &&
      !name.includes("//") &&
      !name.includes("/.") &&
      !name.endsWith("/") &&
      !name.endsWith(".") &&
      !name.endsWith(".lock") &&
      !name.includes(".lock/"),
    { message: "not a branch name git accepts" },
  );

export const PUSH_BRANCH_PREFIX = "agent/";

/** What a push request may add to its session's branch name. */
export const PUSH_BRANCH_SUFFIX_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The branch a session's result is pushed to: `agent/<session-id>`, or
 * `agent/<session-id>-<suffix>`. Joined with `-`, not `/`: git cannot keep
 * `agent/<id>` and `agent/<id>/x` in one repository.
 */
export function pushBranchFor(sessionId: string, suffix?: string): string {
  const base = `${PUSH_BRANCH_PREFIX}${sessionId.toLowerCase()}`;
  return suffix === undefined ? base : `${base}-${suffix}`;
}

/** Whether `branch` is one `pushBranchFor` makes for this session. */
export function isSessionPushBranch(
  sessionId: string,
  branch: string,
): boolean {
  const base = pushBranchFor(sessionId);
  if (branch === base) return true;
  return (
    branch.startsWith(`${base}-`) &&
    PUSH_BRANCH_SUFFIX_PATTERN.test(branch.slice(base.length + 1))
  );
}

/**
 * Catalog ids an additional repository may have: each becomes a git remote
 * name in the workspace and one path segment of the egress route.
 */
export const ADDITIONAL_REPOSITORY_ID_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function additionalRepositoryIdUsable(id: string): boolean {
  return (
    ADDITIONAL_REPOSITORY_ID_PATTERN.test(id) &&
    id !== "origin" &&
    !id.endsWith(".lock") &&
    !id.includes("..")
  );
}

export const pushRequestIdSchema = z.uuid();
export const gitCommitShaSchema = z.string().regex(/^[0-9a-f]{40}$/);

export const pushRequestParamsSchema = sessionIdParamsSchema.extend({
  push_request_id: pushRequestIdSchema,
});

/** What approved a push: a person's decision, or the policy on its own. */
export const PUSH_APPROVAL_BASIS_VALUES = ["human", "policy"] as const;
export type PushApprovalBasis = (typeof PUSH_APPROVAL_BASIS_VALUES)[number];

/**
 * Who decided a push: a person or key, or the policy of a release that
 * pushes without a person's approval. Under the agent's settings the release
 * is only the one the session runs; `agent_settings_revision` names the
 * settings that decided. Absent on deciders written before them.
 */
export const pushDeciderSchema = z.union([
  receiptActorSchema,
  z
    .object({
      kind: z.literal("policy"),
      agent_release_id: agentReleaseIdSchema,
      policy_source: z.enum(GITHUB_POLICY_SOURCE_VALUES).optional(),
      agent_settings_revision: z.number().int().nullable().optional(),
    })
    .strict(),
]);

export const pushRequestSchema = z.object({
  id: pushRequestIdSchema,
  session_id: sessionIdSchema,
  repository_id: z.string().min(1),
  checkpoint_revision: revisionSchema,
  git_commit: gitCommitShaSchema,
  target_branch: z.string().min(1),
  state: pushRequestStateSchema,
  requested_by: receiptActorSchema,
  requested_at: timestampSchema,
  resolved_by: pushDeciderSchema.nullable(),
  resolved_at: timestampSchema.nullable(),
  resolution_reason: z.string().nullable(),
  request_receipt_id: receiptIdSchema,
  resolution_receipt_id: receiptIdSchema.nullable(),
  // Set once the platform's push ended, pushed or failed; its receipt says
  // where the commit went or why it did not.
  finished_at: timestampSchema.nullable(),
  push_receipt_id: receiptIdSchema.nullable(),
  // A server from before intents sends none: that is a direct request.
  origin: pushRequestOriginSchema.default("direct"),
  flow: pushRequestFlowSchema.default("legacy"),
  // Where the pull request step stands; null when none was asked for.
  pr_state: pullRequestStageSchema.nullable().default(null),
  // Why the step ended without a pull request, or what it last failed at
  // (a platform code such as `head_moved`); null while there is none.
  pr_error: z.string().nullable().default(null),
  // The recorded pull request, once there is one.
  pr_number: z.number().int().positive().nullable().default(null),
  pr_url: z.string().nullable().default(null),
});

export const createPushRequestRequestSchema = z
  .object({
    // Omitted: the session's own repository.
    repository_id: z.string().min(1).max(128).optional(),
    // Omitted: `agent/<session-id>`; else `agent/<session-id>-<branch>`.
    branch: z.string().regex(PUSH_BRANCH_SUFFIX_PATTERN).optional(),
    // The saved revision to push. Omitted, the request is refused as
    // `checkpoint_revision_required` and names the latest committed one: this
    // route does not know whether the session's work after it was saved.
    checkpoint_revision: revisionSchema.optional(),
  })
  .strict();

export const PUSH_DECISION_VALUES = ["approve", "reject"] as const;
export const pushDecisionSchema = z.enum(PUSH_DECISION_VALUES);
// The body of `/approve` and `/reject`; the path names the action.
export const resolvePushRequestRequestSchema = z
  .object({
    // The commit the decider reviewed; an approval of any other is refused.
    git_commit: gitCommitShaSchema,
    reason: z.string().min(1).max(1000).optional(),
  })
  .strict();

export const listPushRequestsResponseSchema = z.object({
  items: z.array(pushRequestSchema),
  // Pushes a turn asked for that have no request yet, or ended without one.
  intents: z.array(pushIntentSchema).default([]),
});

// Why a push operation was refused, as its receipt and error details say.
export const PUSH_REFUSAL_VALUES = [
  "missing_scope",
  "unverified_principal",
  "not_found",
  "no_repository",
  "no_checkpoint",
  "checkpoint_unavailable",
  "request_open",
  "already_resolved",
  // `already_resolved` in receipts written before the rename.
  "already_decided",
  "checkpoint_moved",
  "commit_mismatch",
  "catalog_changed",
  "target_refused",
  "default_branch",
  "non_fast_forward",
  "no_push_credential",
  "lease_expired",
  "push_failed",
  "github_settings_unsupported",
  // The GitHub gate refused the push's token; `reason_code` says why.
  "github_refused",
  // A repository other than the session's that its release does not list.
  "repository_not_allowed",
  // A new branch whose commit shares no history with the remote's default
  // branch: most likely another repository's content.
  "unrelated_history",
  // A commit the session made lacks the author, committer, co-author or
  // Agent-Session line the platform issued; `mismatches` names them.
  "attribution_mismatch",
  // The pinned checkpoint commit is the platform's snapshot of tracked files
  // the agent left uncommitted, not a commit of the session's.
  "uncommitted_changes",
  // The deciding key is the key that started the session (GA-8).
  "self_approval",
  // A policy's approval the agent's settings no longer give: it went back to
  // a person before anything was pushed.
  "approval_required",
  // A request made from a pinned revision whose checkpoint no longer verifies
  // for this session, or whose commit is not the request's.
  "pinned_source_invalid",
  // `POST /push-requests` named no saved revision; the answer carries the
  // latest committed one as `checkpoint_revision`.
  "checkpoint_revision_required",
] as const;
export const pushRefusalSchema = z.enum(PUSH_REFUSAL_VALUES);

/**
 * Why, more narrowly: the gate's refusal, or GitHub refusing a push that
 * changes `.github/workflows/` with a token lacking `workflows`.
 */
export const pushReasonCodeSchema = z.union([
  githubRefusalSchema,
  z.literal("workflows_permission_missing"),
]);

/** One commit whose attribution is wrong, and which parts are. */
export const attributionMismatchSchema = z.object({
  commit: gitCommitShaSchema,
  problems: z.array(
    z.enum([
      "author",
      "committer",
      "co_author",
      "engine_co_author",
      "agent_session",
    ]),
  ),
});
/** A refusal lists at most this many; the first are the oldest. */
export const MAX_ATTRIBUTION_MISMATCHES = 20;

/**
 * `result` of a `request_push`, `resolve_push` or `push` receipt. Fields the
 * refused attempt never learned (a scope refusal reads no row) are null.
 */
export const pushReceiptResultSchema = z.object({
  push_request_id: pushRequestIdSchema.nullable(),
  action: pushDecisionSchema.nullable().optional(),
  // `action` in receipts written before the rename.
  decision: pushDecisionSchema.nullable().optional(),
  verdict: z.enum(["allow", "refuse"]),
  refusal: pushRefusalSchema.nullable(),
  repository_id: z.string().nullable(),
  checkpoint_revision: revisionSchema.nullable(),
  git_commit: gitCommitShaSchema.nullable(),
  target_branch: z.string().nullable(),
  // A `push` receipt only: where the commit went, what the ref held before,
  // and who approved it.
  remote_url: z.string().nullable().optional(),
  remote_ref: z.string().nullable().optional(),
  previous_commit: gitCommitShaSchema.nullable().optional(),
  approved_by: pushDeciderSchema.nullable().optional(),
  reason_code: pushReasonCodeSchema.nullable().optional(),
  // `attribution_mismatch` only: the commits that fail the check.
  mismatches: z
    .array(attributionMismatchSchema)
    .max(MAX_ATTRIBUTION_MISMATCHES)
    .optional(),
  // A `resolve_push` receipt only: the API key that decided, or null for a
  // person or the policy.
  decider_key: deciderKeySchema.nullable().optional(),
  ...githubPolicyReceiptFieldsSchema.shape,
});

export type PushRequestState = (typeof PUSH_REQUEST_STATE_VALUES)[number];
export type PushRequest = z.infer<typeof pushRequestSchema>;
export type PushDecision = z.infer<typeof pushDecisionSchema>;
export type PushDecider = z.infer<typeof pushDeciderSchema>;
export type CreatePushRequestRequest = z.infer<
  typeof createPushRequestRequestSchema
>;
/** What the service resolves: the path's action joined to the body. */
export type PushResolution = ResolvePushRequestRequest & {
  decision: PushDecision;
};
export type ResolvePushRequestRequest = z.infer<
  typeof resolvePushRequestRequestSchema
>;
export type ListPushRequestsResponse = z.infer<
  typeof listPushRequestsResponseSchema
>;
export type PushRefusal = z.infer<typeof pushRefusalSchema>;
export type AttributionMismatchDetail = z.infer<
  typeof attributionMismatchSchema
>;
export type PushReasonCode = z.infer<typeof pushReasonCodeSchema>;
export type PushReceiptResult = z.infer<typeof pushReceiptResultSchema>;
