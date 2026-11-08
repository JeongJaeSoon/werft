import { z } from "zod";

import {
  type AgentGitHub,
  MCP_TOOL_PREFIX,
  type PushAttached,
} from "../kollegium/agents.ts";
import {
  ACTION_REFUSAL_CODES,
  type ActionRefusalCode,
  type ActionRefusalSpec,
  actionRefusalSpec,
  actionResultSchema,
} from "./action-broker.ts";
import {
  dispatchWorkflowRequestSchema,
  dispatchWorkflowResponseSchema,
  githubWorkflowRunSchema,
  rerunWorkflowRequestSchema,
  rerunWorkflowResponseSchema,
  submitPullRequestReviewRequestSchema,
  submitPullRequestReviewResponseSchema,
} from "./github-work.ts";
import {
  commentPullRequestRequestSchema,
  commentPullRequestResponseSchema,
  mergePullRequestResponseSchema,
  openPullRequestRequestSchema,
  openPullRequestResultSchema,
  setPullRequestStateResponseSchema,
  updatePullRequestRequestSchema,
  updatePullRequestResponseSchema,
} from "./pull-request.ts";
import {
  createPushRequestRequestSchema,
  pullRequestStageSchema,
  pushIntentRefusalSchema,
  pushIntentStatusSchema,
  pushRequestIdSchema,
  pushRequestSchema,
  pushRequestStateSchema,
} from "./push-request.ts";
import { githubPolicyReceiptFieldsSchema } from "./receipt.ts";

/** Exactly one of the two ids names the push the call is about. */
const hasOneOfPushIds = (a: {
  push_request_id?: string | undefined;
  push_intent_id?: string | undefined;
}) => (a.push_request_id === undefined) !== (a.push_intent_id === undefined);
const ONE_PUSH_ID_MESSAGE =
  "give exactly one of push_request_id and push_intent_id";

/**
 * What `get_push_request` answers: the intent, the push request and the pull
 * request stage of one push, read together. Public codes only.
 */
export const pushRequestSnapshotSchema = z
  .object({
    push_intent_id: z.uuid().nullable(),
    intent_status: pushIntentStatusSchema.nullable(),
    intent_refusal: pushIntentRefusalSchema.nullable(),
    push_request_id: pushRequestIdSchema.nullable(),
    push_state: pushRequestStateSchema.nullable(),
    repository_id: z.string(),
    target_branch: z.string(),
    pull_request_scheduled: z.boolean(),
    pull_request_stage: pullRequestStageSchema.nullable(),
    pull_request_error: z.string().nullable(),
    pull_request: z
      .object({ number: z.number().int(), url: z.string() })
      .nullable(),
  })
  .strict();
export type PushRequestSnapshot = z.infer<typeof pushRequestSnapshotSchema>;

/**
 * The built-in MCP server a session's agent reaches GitHub through (design
 * github-agent.md §3 "내장 MCP 서버 github"). A catalog MCP server may not
 * take this id.
 */
export const GITHUB_MCP_SERVER = "github";

const runIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

/**
 * The longest a waiting read may hold its answer. The built-in server is
 * served by the control host's authorizer listener, which keeps Bun's default
 * 10 second idle timeout. Bun checks it on a coarse timer, so the cut does
 * not land at 10: in a probe with the same `Bun.serve` options on Bun 1.3.14,
 * 32 of 32 silent calls were cut between 8.01 and 12.01 seconds after they
 * started. The wait is counted from the start of the call; the waiting itself
 * and the GitHub calls inside it are cut at that deadline. The database reads
 * around it keep their own pool timeouts, so the cap leaves about a second
 * below the earliest cut seen for them, the proxy and the answer; it is a
 * margin, not a guarantee.
 */
export const GITHUB_MCP_WAIT_SECONDS_MAX = 7;

const waitSecondsSchema = z
  .number()
  .int()
  .min(0)
  .max(GITHUB_MCP_WAIT_SECONDS_MAX)
  .optional();

/** `list_repositories` answers this many repositories a page unless asked for fewer. */
export const LIST_REPOSITORIES_LIMIT_DEFAULT = 100;
export const LIST_REPOSITORIES_LIMIT_MAX = 500;

/**
 * Each tool's arguments: the session API's body plus what that API takes
 * from the path. Never a session id: the attempt token names the session.
 */
export const GITHUB_MCP_TOOL_ARGUMENTS = {
  // The REST body plus `source_ref`, which only the tool takes. Until the
  // multi-branch stage it is answered `source_ref_unsupported`.
  request_push: createPushRequestRequestSchema
    .safeExtend({
      source_ref: z.string().min(1).max(255).optional(),
      // Accepted only where the PR tool is trusted; elsewhere
      // `pull_request_needs_tool_call` (nothing is created).
      pull_request: openPullRequestRequestSchema.optional(),
    })
    .strict(),
  open_pull_request: openPullRequestRequestSchema
    .safeExtend({
      push_request_id: pushRequestIdSchema.optional(),
      push_intent_id: z.uuid().optional(),
    })
    .refine(hasOneOfPushIds, { message: ONE_PUSH_ID_MESSAGE }),
  get_push_request: z
    .object({
      push_request_id: pushRequestIdSchema.optional(),
      push_intent_id: z.uuid().optional(),
    })
    .strict()
    .refine(hasOneOfPushIds, { message: ONE_PUSH_ID_MESSAGE }),
  update_pull_request: updatePullRequestRequestSchema.safeExtend({
    push_request_id: pushRequestIdSchema,
  }),
  comment_pull_request: commentPullRequestRequestSchema.extend({
    push_request_id: pushRequestIdSchema,
  }),
  close_pull_request: z
    .object({ push_request_id: pushRequestIdSchema })
    .strict(),
  reopen_pull_request: z
    .object({ push_request_id: pushRequestIdSchema })
    .strict(),
  merge_pull_request: z
    .object({ push_request_id: pushRequestIdSchema })
    .strict(),
  dispatch_workflow: dispatchWorkflowRequestSchema,
  get_workflow_run: z
    .object({ run_id: runIdSchema, wait_seconds: waitSecondsSchema })
    .strict(),
  rerun_workflow: rerunWorkflowRequestSchema.extend({ run_id: runIdSchema }),
  submit_review: submitPullRequestReviewRequestSchema.safeExtend({
    number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  list_repositories: z
    .object({
      limit: z
        .number()
        .int()
        .min(1)
        .max(LIST_REPOSITORIES_LIMIT_MAX)
        .optional(),
      cursor: z.string().min(1).max(256).optional(),
      query: z.string().min(1).max(128).optional(),
    })
    .strict(),
  attach_repository: z
    .object({
      repository_id: z.string().min(1).max(128),
      wait_seconds: waitSecondsSchema,
    })
    .strict(),
} as const;

export type GitHubMcpTool = keyof typeof GITHUB_MCP_TOOL_ARGUMENTS;

/** The release feature a tool needs; null for the default work. */
export const GITHUB_MCP_TOOL_FEATURES: Record<
  GitHubMcpTool,
  keyof AgentGitHub["features"] | null
> = {
  request_push: null,
  open_pull_request: null,
  get_push_request: null,
  update_pull_request: null,
  comment_pull_request: null,
  close_pull_request: null,
  reopen_pull_request: null,
  merge_pull_request: null,
  dispatch_workflow: "actions",
  get_workflow_run: "actions",
  rerun_workflow: "actions",
  submit_review: "review",
  list_repositories: null,
  attach_repository: null,
};

/**
 * One repository `list_repositories` names: the session's own (`primary`),
 * one on its attached list (`attached`, or the fetch's `pending`/`failed`),
 * one the release allows that `attach_repository` would add
 * (`available`), or one only the agent's active release allows, which the
 * session cannot attach because it stays on the release it started with
 * (`allowed_in_newer_release`). `name` is the URL's path, never its
 * credentials.
 */
export const LISTED_REPOSITORY_STATUS_VALUES = [
  "primary",
  "attached",
  "pending",
  "failed",
  "available",
  "allowed_in_newer_release",
] as const;

/**
 * `details.reason_code` of an `attach_repository` refused with
 * `GITHUB_REFUSED`: off the session's release, or off it but allowed by the
 * agent's active release (a new session can attach it; nothing needs to be
 * allowed again).
 */
export const REPOSITORY_ATTACH_REFUSAL_VALUES = [
  "repository_not_allowed",
  "allowed_in_newer_release",
] as const;
export type RepositoryAttachRefusal =
  (typeof REPOSITORY_ATTACH_REFUSAL_VALUES)[number];

/** The status in plain words, so an answer to a person need not quote it. */
export const LISTED_REPOSITORY_MEANING = {
  primary: "the repository this session works in",
  attached: "attached to this session",
  pending: "being attached to this session now",
  failed: "attaching it to this session failed",
  available: "not attached yet; it can be attached on request",
  allowed_in_newer_release:
    "allowed only for new sessions; this session cannot attach it",
} as const satisfies Record<
  (typeof LISTED_REPOSITORY_STATUS_VALUES)[number],
  string
>;

export const listedRepositorySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  branch: z.string().nullable(),
  status: z.enum(LISTED_REPOSITORY_STATUS_VALUES),
  meaning: z.string(),
});
export type ListedRepository = z.infer<typeof listedRepositorySchema>;

export const listRepositoriesResponseSchema = z.object({
  repositories: z.array(listedRepositorySchema),
  /**
   * Pass it as `cursor` for the next page; null on the last. A call that
   * sends no `limit` or `cursor` gets the first page, so a caller from before
   * pages reads at most the first `LIST_REPOSITORIES_LIMIT_DEFAULT`.
   */
  next_cursor: z.string().nullable(),
});
export type ListRepositoriesResponse = z.infer<
  typeof listRepositoriesResponseSchema
>;

export const REPOSITORY_ATTACHMENT_STATUS_VALUES = [
  "pending",
  "attached",
  "failed",
] as const;

/**
 * Why a fetch the worker ran for an attachment ended without the remote:
 * over the time or size limit, or any other git failure.
 */
export const REPOSITORY_ATTACH_FAILURE_VALUES = [
  "fetch_timeout",
  "fetch_too_large",
  "fetch_failed",
] as const;
export const repositoryAttachFailureSchema = z.enum(
  REPOSITORY_ATTACH_FAILURE_VALUES,
);

/**
 * What `attach_repository` answers, and the `result` of its receipt.
 * `pending` while the worker has not reported the fetch yet; calling again
 * reads the same attachment. `already_attached` when the call changed
 * nothing: the session's own repository, one attached before, or a session
 * whose list is the release's whole list.
 */
export const repositoryAttachmentSchema = z.object({
  repository_id: z.string().min(1),
  status: z.enum(REPOSITORY_ATTACHMENT_STATUS_VALUES),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  failure: repositoryAttachFailureSchema.nullable(),
  already_attached: z.boolean(),
  receipt_id: z.string().nullable(),
});
export type RepositoryAttachment = z.infer<typeof repositoryAttachmentSchema>;

/**
 * What the MCP tool answers: the attachment and whether it can still change.
 * `final` is false only while `status` is `pending` at the end of the wait.
 */
export const waitedRepositoryAttachmentSchema =
  repositoryAttachmentSchema.safeExtend({ final: z.boolean() });

/**
 * What `get_workflow_run` answers: the run and whether it can still change.
 * `final` is true once GitHub reports it `completed`.
 */
export const waitedWorkflowRunSchema = githubWorkflowRunSchema.safeExtend({
  final: z.boolean(),
});
export type RepositoryAttachFailure = z.infer<
  typeof repositoryAttachFailureSchema
>;

/**
 * `result` of an `attach_repository` receipt: who asked from which attempt,
 * under which release, and what the worker fetched. `reason_code` is the
 * gate's refusal, as on the GitHub gate's own receipts.
 */
export const attachRepositoryReceiptResultSchema = z.object({
  session_id: z.string(),
  attempt_id: z.string(),
  agent_id: z.string().nullable(),
  agent_release_id: z.string().nullable(),
  repository_id: z.string(),
  branch: z.string().nullable(),
  commit: z.string().nullable(),
  failure: repositoryAttachFailureSchema.nullable(),
  reason_code: z.string().nullable(),
  ...githubPolicyReceiptFieldsSchema.shape,
});

/**
 * What kind of action a tool is, the unit a policy value is set on (design
 * 8.1). `push` is judged per repository as `push.primary` or `push.attached`
 * (`pushClassOf`). There is no `administration`: no tool does that.
 */
export const ACTION_CLASS_VALUES = [
  "push",
  "pull_request.write",
  "pull_request.merge",
  "review",
  "workflow",
  "repository.read",
] as const;
export type ActionClass = (typeof ACTION_CLASS_VALUES)[number];

/**
 * Every tool's class. A `Record` over the tool names, so a tool added to
 * `GITHUB_MCP_TOOL_ARGUMENTS` without a class here does not typecheck, and
 * `listedGitHubMcpTools` leaves out one that slips through at run time.
 */
export const GITHUB_MCP_TOOL_CLASSES: Record<GitHubMcpTool, ActionClass> = {
  request_push: "push",
  open_pull_request: "pull_request.write",
  // A read of the push the model asked for; its class is the push's.
  get_push_request: "push",
  update_pull_request: "pull_request.write",
  comment_pull_request: "pull_request.write",
  close_pull_request: "pull_request.write",
  reopen_pull_request: "pull_request.write",
  merge_pull_request: "pull_request.merge",
  dispatch_workflow: "workflow",
  get_workflow_run: "workflow",
  rerun_workflow: "workflow",
  submit_review: "review",
  list_repositories: "repository.read",
  attach_repository: "repository.read",
};

/** The names that have a class: the only tools a session can list or call. */
export function listedGitHubMcpTools(
  names: readonly string[],
  classes: Readonly<
    Record<string, ActionClass | undefined>
  > = GITHUB_MCP_TOOL_CLASSES,
): GitHubMcpTool[] {
  return names.filter(
    (name): name is GitHubMcpTool =>
      Object.hasOwn(classes, name) &&
      classes[name] !== undefined &&
      ACTION_CLASS_VALUES.includes(classes[name]),
  );
}

/** The class a push to `repositoryId` is judged under. */
export function pushClassOf(
  sessionRepositoryId: string | null,
  repositoryId: string,
): "push.primary" | "push.attached" {
  return repositoryId === sessionRepositoryId
    ? "push.primary"
    : "push.attached";
}

export type ActionPolicy = {
  "push.primary": "allow" | "ask";
  "push.attached": PushAttached;
  "pull_request.write": "allow";
  "pull_request.merge": "workspace_ceiling";
  review: "allow" | "deny";
  workflow: "allow" | "deny";
  "repository.read": "allow";
};

/**
 * The policy per class, computed from the effective settings; nothing is
 * stored per class. `push.primary` is `push_approval`; `push.attached` is
 * its own value.
 */
export function actionPolicyOf(
  github: AgentGitHub,
  pushAttached: PushAttached,
): ActionPolicy {
  return {
    "push.primary": github.push_approval ? "ask" : "allow",
    "push.attached": pushAttached,
    "pull_request.write": "allow",
    "pull_request.merge": "workspace_ceiling",
    review: github.features.review ? "allow" : "deny",
    workflow: github.features.actions ? "allow" : "deny",
    "repository.read": "allow",
  };
}

/**
 * The tools a release exposes, by the release's features alone. The server's
 * list, the egress check of a call and the worker's relay all read this.
 */
export function githubMcpTools(github: AgentGitHub): GitHubMcpTool[] {
  return listedGitHubMcpTools(Object.keys(GITHUB_MCP_TOOL_FEATURES)).filter(
    (tool) => {
      const feature = GITHUB_MCP_TOOL_FEATURES[tool];
      return feature === null || github.features[feature];
    },
  );
}

/**
 * The tools an `agent` session always sees, whatever its settings say now:
 * its runtime config, and so its checkpoint fingerprint, must not follow a
 * change to them. Each call is judged instead.
 */
export const GITHUB_MCP_FIXED_TOOLS = listedGitHubMcpTools(
  Object.keys(GITHUB_MCP_TOOL_FEATURES),
);

/**
 * What each tool does, in terms of its fields. Never an instruction to the
 * model: what to do next is the model's call, and what a refusal means is
 * its code.
 */
export const GITHUB_MCP_TOOL_DESCRIPTIONS: Record<GitHubMcpTool, string> = {
  request_push:
    "Request a push to branch agent/<session-id>, or agent/<session-id>-<branch> when `branch` is given. `repository_id` names an attached repository; omitted, the session's own. With the installation's agent action flows on, a call inside a running turn pushes the state this turn ends with, and the answer is `deferred` with `push_intent_id` and `waits_for: turn_end`; the platform makes the push request when the turn ends, and no later turn starts for the pull request: call `open_pull_request` with that `push_intent_id` in the same turn, also when the push needs approval. Otherwise (the flows off, or no running turn) the last checkpoint is pushed and the push request is returned, which waits for a person when the release requires approval, or `deferred` when no checkpoint exists yet. A push carries the workspace HEAD of the checkpoint it is made from, and the history before it: for an attached repository that is its branch checked out in the workspace (a git worktree or clone elsewhere is not captured), with `repository_id` naming that repository. With the flows on, that checkpoint is the one taken when the turn ends, and every push request of the turn is pinned to it, whichever repository it names; a push request for a repository other than the one checked out does not select that repository's state, and a new target branch whose history shares nothing with the target's default branch is refused as `unrelated_history` (an existing target branch gives `non_fast_forward` instead). The platform does not hold a second repository's request for a later turn. `source_ref` is not supported yet, and with the flows on a turn takes one target per repository: a second `branch` in the same turn is refused with `source_ref_unsupported`, so say what is left and push it in the next turn. `pull_request` is not accepted yet: a call that carries it is refused with `pull_request_needs_tool_call` and nothing is created; open the pull request with `open_pull_request` (in a running turn with the flows on, with the `push_intent_id` this call returns).",
  get_push_request:
    "Read where one push stands: the intent (`intent_status`, `intent_refusal`), the push request (`push_state`) and its pull request stage (`pull_request_stage`, `pull_request_error`, `pull_request`). Give `push_request_id` or `push_intent_id`, never both; both ids answer the same push once the intent became a push request.",
  open_pull_request:
    "Open, or return the already open, pull request from the branch and commit of a pushed push request (`push_request_id`), or, with the installation's agent action flows on, schedule it with `push_intent_id` (or a push request that is not pushed yet): `scheduled` means the platform opens it once the push finishes, with the content of the first call. With the flows off, a push request that is not pushed yet is refused with `not_pushed`. A pull request already open for the branch on another commit than the pushed one is refused with `head_moved` and not adopted. Content fields: `title`; `summary` (what changed and why, a few sentences); `changes` (one change per item); `rationale` (the reason for the change); `testing` (how it was checked); `notes` (what a reviewer needs to know); `related` (issues: `number`, optional `repository_id`, `closes` to close it on merge). `body` is the legacy single text and cannot be combined with the fields above.",
  update_pull_request:
    "Set the title or the content of the pull request that the push request's branch has open. Given any of `summary`, `changes`, `rationale`, `testing`, `notes` or `related`, the body is written again from those fields (a field left out is empty); `body` (legacy) replaces the body as text; `title` alone leaves the body. The platform's closing lines stay, naming the push request's commit.",
  comment_pull_request:
    "Add a comment to the pull request of a pushed push request. The same `marker` edits the same comment.",
  close_pull_request:
    "Close the pull request of a pushed push request without merging it; the branch stays. `changed` is false when it was already closed.",
  reopen_pull_request:
    "Reopen the closed pull request of a pushed push request. `changed` is false when it was already open.",
  merge_pull_request:
    "Squash-merge the pull request of a pushed push request of this session, on the commit that push request pushed. Only while the workspace allows it: otherwise the call is refused with `github_refused` (`reason_code` `merge_off`) before GitHub is called. GitHub still decides on required checks, reviews and conversations (`merge_blocked`); a pull request whose head is not the pushed commit is refused with `head_moved`. `changed` is false and `method` null when the pull request was already merged on that commit.",
  dispatch_workflow:
    "Dispatch an allow-listed workflow on a branch. `inputs` go to GitHub only.",
  get_workflow_run: `Read a workflow run of the session's repository. \`wait_seconds\` (0 to ${GITHUB_MCP_WAIT_SECONDS_MAX}, default 0) holds the answer until the run is \`completed\` or the seconds have passed. \`final\` is true when the run is \`completed\`, false when it was still running at the end of the wait.`,
  rerun_workflow:
    "Rerun a workflow run that the platform dispatched for the session's repository.",
  submit_review:
    "Submit a review of a pull request as the reviewer App, on the commit named by `commit_id`.",
  list_repositories: `List the repositories the session can work on, ${LIST_REPOSITORIES_LIMIT_DEFAULT} a page. The session's own comes first on the first page and is not counted in \`limit\` (1 to ${LIST_REPOSITORIES_LIMIT_MAX}); the others are in id order. \`next_cursor\` is non-null when more follow: send it back as \`cursor\`. \`query\` keeps those whose id or name contains it. \`status\` is \`primary\` (the session's own), \`attached\`, \`pending\` or \`failed\` (fetch in progress or failed), \`available\` (attach_repository would add it) or \`allowed_in_newer_release\` (only the agent's current release allows it). Each repository's \`meaning\` is its status in plain words.`,
  attach_repository: `Attach a repository the release allows to the session as a git remote named \`repository_id\`, with its default branch fetched to \`<repository_id>/<branch>\`. \`status\` is \`pending\` while the fetch runs. \`wait_seconds\` (0 to ${GITHUB_MCP_WAIT_SECONDS_MAX}, default 0) holds the answer until the fetch ends or the seconds have passed; \`final\` is false when the fetch was still running at the end of the wait. Attaching an attached repository changes nothing. Changes to it are pushed from a branch of \`<repository_id>/<branch>\` checked out in the workspace; a git worktree or clone elsewhere is not captured, and a push carries the workspace HEAD of its checkpoint (with the flows on, the checkpoint taken when the turn ends, shared by every push request of that turn).`,
};

const requestPushResultSchema = z.union([
  pushRequestSchema,
  // The release's settings keep the follow-up turn (`push_continuations`):
  // no checkpoint yet, the push request is made one turn later.
  z
    .object({
      status: z.literal("deferred"),
      continuation: z.literal("after_turn"),
    })
    .strict(),
  // Inside a running turn with AGENT_ACTION_FLOWS on: "push what this turn
  // ends with". The platform makes the push request after the turn ends.
  z
    .object({
      status: z.literal("deferred"),
      push_intent_id: z.uuid(),
      waits_for: z.literal("turn_end"),
      repository_id: z.string(),
      target_branch: z.string(),
      pull_request: z.enum(["scheduled", "none"]),
      next: z.string(),
    })
    .strict(),
]);

/** The envelope each tool answers with, as `outputSchema` states it. */
export const GITHUB_MCP_TOOL_OUTPUTS = {
  request_push: actionResultSchema(requestPushResultSchema),
  open_pull_request: actionResultSchema(openPullRequestResultSchema),
  get_push_request: actionResultSchema(pushRequestSnapshotSchema),
  update_pull_request: actionResultSchema(updatePullRequestResponseSchema),
  comment_pull_request: actionResultSchema(commentPullRequestResponseSchema),
  close_pull_request: actionResultSchema(setPullRequestStateResponseSchema),
  reopen_pull_request: actionResultSchema(setPullRequestStateResponseSchema),
  merge_pull_request: actionResultSchema(mergePullRequestResponseSchema),
  dispatch_workflow: actionResultSchema(dispatchWorkflowResponseSchema),
  get_workflow_run: actionResultSchema(waitedWorkflowRunSchema),
  rerun_workflow: actionResultSchema(rerunWorkflowResponseSchema),
  submit_review: actionResultSchema(submitPullRequestReviewResponseSchema),
  list_repositories: actionResultSchema(listRepositoriesResponseSchema),
  attach_repository: actionResultSchema(waitedRepositoryAttachmentSchema),
} as const satisfies Record<GitHubMcpTool, z.ZodType>;

const COMMON_REFUSALS = [
  "validation_error",
  "internal_error",
  "forbidden",
  "github_disabled",
  "feature_off",
] as const satisfies readonly ActionRefusalCode[];

const PULL_REQUEST_REFUSALS = [
  ...COMMON_REFUSALS,
  "missing_scope",
  "unverified_principal",
  "not_found",
  "not_pushed",
  "push_rejected",
  "push_failed",
  "superseded",
  "intent_ended",
  "head_moved",
  "catalog_changed",
  "no_forge",
  "github_settings_unsupported",
  "github_refused",
  "forge_failed",
  "backend_unavailable",
] as const satisfies readonly ActionRefusalCode[];

const GITHUB_WORK_REFUSALS = [
  ...COMMON_REFUSALS,
  "not_found",
  "github_refused",
  "backend_unavailable",
] as const satisfies readonly ActionRefusalCode[];

/**
 * The codes a tool can refuse with (catalog 5.5 to 5.7). A refusal of a
 * tool carries the `by` and `retryable` its code fixes in
 * `ACTION_REFUSAL_CODES`, unless `GITHUB_MCP_REFUSAL_OVERRIDES` says
 * otherwise for that tool.
 */
export const GITHUB_MCP_TOOL_REFUSALS: Record<
  GitHubMcpTool,
  readonly ActionRefusalCode[]
> = {
  request_push: [
    ...COMMON_REFUSALS,
    "missing_scope",
    "unverified_principal",
    "not_found",
    "no_repository",
    "repository_not_allowed",
    "no_checkpoint",
    "checkpoint_unavailable",
    "request_open",
    "catalog_changed",
    "default_branch",
    "target_refused",
    "attribution_mismatch",
    "uncommitted_changes",
    "pull_request_needs_tool_call",
    "github_settings_unsupported",
    "github_refused",
    "backend_unavailable",
    "source_ref_unsupported",
    "no_running_turn",
  ],
  open_pull_request: PULL_REQUEST_REFUSALS,
  get_push_request: [
    ...COMMON_REFUSALS,
    "missing_scope",
    "unverified_principal",
    "not_found",
    "backend_unavailable",
  ],
  update_pull_request: [...PULL_REQUEST_REFUSALS, "no_pull_request"],
  comment_pull_request: [...PULL_REQUEST_REFUSALS, "no_pull_request"],
  close_pull_request: [
    ...PULL_REQUEST_REFUSALS,
    "no_pull_request",
    "pull_request_merged",
  ],
  reopen_pull_request: [
    ...PULL_REQUEST_REFUSALS,
    "no_pull_request",
    "pull_request_merged",
  ],
  merge_pull_request: [
    ...PULL_REQUEST_REFUSALS,
    "no_pull_request",
    "merge_off",
    "merge_blocked",
    "pull_request_closed",
  ],
  dispatch_workflow: GITHUB_WORK_REFUSALS,
  get_workflow_run: GITHUB_WORK_REFUSALS,
  rerun_workflow: GITHUB_WORK_REFUSALS,
  submit_review: [...GITHUB_WORK_REFUSALS, "stale_commit"],
  list_repositories: GITHUB_WORK_REFUSALS,
  attach_repository: [
    ...GITHUB_WORK_REFUSALS,
    "repository_not_allowed",
    "allowed_in_newer_release",
  ],
};

/**
 * A pull request tool reads a push request that failed as final (catalog
 * 5.6); the same code on `request_push` is a push that can be tried again.
 */
export const GITHUB_MCP_REFUSAL_OVERRIDES: Partial<
  Record<GitHubMcpTool, Partial<Record<ActionRefusalCode, ActionRefusalSpec>>>
> = {
  open_pull_request: { push_failed: actionRefusalSpec("platform") },
  update_pull_request: { push_failed: actionRefusalSpec("platform") },
  comment_pull_request: { push_failed: actionRefusalSpec("platform") },
  // The service answers a GitHub outage and a permanent refusal of the state
  // change (a pull request merged between its read and its PATCH) with the
  // same `forge_failed`, so a retry cannot be promised.
  close_pull_request: {
    push_failed: actionRefusalSpec("platform"),
    forge_failed: actionRefusalSpec("github"),
  },
  reopen_pull_request: {
    push_failed: actionRefusalSpec("platform"),
    forge_failed: actionRefusalSpec("github"),
  },
  merge_pull_request: { push_failed: actionRefusalSpec("platform") },
};

/** The `by` and `retryable` of a tool's code, or null if it has no such code. */
export function githubMcpRefusalSpec(
  tool: GitHubMcpTool,
  code: unknown,
): ActionRefusalSpec | null {
  if (typeof code !== "string") return null;
  if (!(GITHUB_MCP_TOOL_REFUSALS[tool] as readonly string[]).includes(code)) {
    return null;
  }
  return (
    GITHUB_MCP_REFUSAL_OVERRIDES[tool]?.[code as ActionRefusalCode] ??
    ACTION_REFUSAL_CODES[code as ActionRefusalCode]
  );
}

/** The engine's names for them: `mcp__github__<tool>`. */
export function githubMcpToolNames(tools: readonly GitHubMcpTool[]): string[] {
  return tools.map((tool) => `${MCP_TOOL_PREFIX}${GITHUB_MCP_SERVER}__${tool}`);
}
