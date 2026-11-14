import { z } from "zod";
import {
  dispatchWorkflowRequestSchema,
  dispatchWorkflowResponseSchema,
  githubWorkflowRunSchema,
  rerunWorkflowRequestSchema,
  rerunWorkflowResponseSchema,
  submitPullRequestReviewRequestSchema,
  submitPullRequestReviewResponseSchema,
} from "../api/github-work.ts";
import {
  commentPullRequestRequestSchema,
  commentPullRequestResponseSchema,
  mergePullRequestResponseSchema,
  openPullRequestRequestSchema,
  openPullRequestResultSchema,
  setPullRequestStateResponseSchema,
  updatePullRequestRequestSchema,
  updatePullRequestResponseSchema,
} from "../api/pull-request.ts";
import {
  createPushRequestRequestSchema,
  pullRequestStageSchema,
  pushIntentRefusalSchema,
  pushIntentStatusSchema,
  pushRequestIdSchema,
  pushRequestSchema,
  pushRequestStateSchema,
  sourceRefSchema,
} from "../api/push-request.ts";
import { type AgentGitHub, MCP_TOOL_PREFIX } from "../kollegium/agents.ts";
import {
  ACTION_REFUSAL_CODES,
  type ActionRefusalCode,
  type ActionRefusalSpec,
  actionRefusalSpec,
  actionResultSchema,
} from "./action-broker.ts";

/** Exactly one of the two ids names the push the call is about. */
const hasOneOfPushIds = (a: {
  push_request_id?: string | undefined;
  push_intent_id?: string | undefined;
}) => (a.push_request_id === undefined) !== (a.push_intent_id === undefined);
const ONE_PUSH_ID_MESSAGE =
  "exactly one of push_request_id and push_intent_id is accepted";

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
 * The most of a pull request body `get_pull_request` answers, in UTF-8
 * bytes. GitHub takes 65536 characters, so a body of multi-byte text can be
 * longer than this.
 */
export const GET_PULL_REQUEST_BODY_MAX_BYTES = 65_536;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What `get_pull_request` answers. `body` is the body without the platform's
 * tail, redacted line by line; `body_sha256` is of the whole body as GitHub
 * holds it, tail included, and null when `body` was cut.
 */
export const pullRequestReadSchema = z
  .object({
    number: z.number().int(),
    url: z.string(),
    state: z.enum(["open", "closed", "merged"]),
    title: z.string(),
    body: z.string(),
    body_truncated: z.boolean(),
    body_sha256: sha256HexSchema.nullable(),
    head_sha: z.string(),
    base: z.string(),
    // Anyone who can edit the pull request wrote this text.
    untrusted: z.literal(true),
  })
  .strict();
export type PullRequestRead = z.infer<typeof pullRequestReadSchema>;

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
 * One repository `list_repositories` names: the session's own or one on its
 * attached list (`attached`, or the fetch's `pending`/`failed`), one the
 * release allows that `attach_repository` would add (`not_attached`), or one
 * only the agent's active release allows, which the session cannot attach
 * because it stays on the release it started with
 * (`allowed_in_newer_release`). `name` is the URL's path, never its
 * credentials.
 *
 * `primary` and `available` are no longer produced: the list is one list in
 * id order and the session's own is `attached` with `remote: "origin"`. They
 * stay here so that a client built before that still parses a stored or
 * older response. `revoked` is a repository that was attached, the session's
 * own included, and the agent's settings no longer allow; its working copy is
 * left in place.
 */
export const LISTED_REPOSITORY_STATUS_VALUES = [
  "primary",
  "attached",
  "pending",
  "failed",
  "available",
  "allowed_in_newer_release",
  "not_attached",
  "revoked",
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
  not_attached: "allowed, but nothing is fetched into this session yet",
  revoked: "was attached, but is no longer allowed",
} as const satisfies Record<
  (typeof LISTED_REPOSITORY_STATUS_VALUES)[number],
  string
>;

export const listedRepositorySchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  branch: z.string().nullable(),
  status: z.enum(LISTED_REPOSITORY_STATUS_VALUES),
  /** Optional so a list from before it was added still parses. */
  meaning: z.string().optional(),
  /** The git remote name an `attached` repository was given; absent otherwise. */
  remote: z.string().min(1).optional(),
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
 * What kind of action a tool is, the unit a policy value is set on. `push`
 * is judged by `pushDecisionOf`. There is no `administration`: no tool does that.
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

/**
 * The class a push is recorded under (`push_intents.approval_basis`). A
 * stored value is audit only: the intent runner judges the push again with
 * the policy of that moment, whichever class it was made under.
 */
export const PUSH_CLASS_VALUES = [
  "push",
  "push.primary",
  "push.attached",
] as const;
export type PushClass = (typeof PUSH_CLASS_VALUES)[number];

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

const requestPushResultSchema = z.union([
  pushRequestSchema,
  // Inside a running turn: the push is of what this turn ends with, and the
  // platform makes the push request after the turn ends.
  z
    .object({
      status: z.literal("deferred"),
      push_intent_id: z.uuid(),
      waits_for: z.literal("reply_end"),
      repository_id: z.string(),
      target_branch: z.string(),
      pull_request: z.enum(["scheduled", "none"]),
    })
    .strict(),
]);

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

/** One row of `GITHUB_MCP_TOOLS`: everything the platform knows about a tool. */
type GitHubMcpToolDefinition = {
  /**
   * The tool's arguments: the session API's body plus what that API takes
   * from the path. Never a session id: the attempt token names the session.
   */
  arguments: z.ZodType;
  /** The envelope the tool answers with, as `outputSchema` states it. */
  output: z.ZodType;
  /** The release feature the tool needs; null for the default work. */
  feature: keyof AgentGitHub["features"] | null;
  /** The policy unit the tool is judged under. */
  actionClass: ActionClass;
  /**
   * What the tool does, in terms of its fields, effects and purpose. Never an
   * instruction to the model: what to do next is the model's call, and what a
   * refusal means is its code.
   */
  description: string;
  /**
   * The codes the tool can refuse with (catalog 5.5 to 5.7). A refusal
   * carries the `by` and `retryable` its code fixes in `ACTION_REFUSAL_CODES`,
   * unless `refusalOverrides` says otherwise for this tool.
   */
  refusals: readonly ActionRefusalCode[];
  refusalOverrides?: Partial<Record<ActionRefusalCode, ActionRefusalSpec>>;
};

/**
 * Every GitHub MCP tool, one row each. The other `GITHUB_MCP_TOOL_*` exports
 * are columns of this table: a tool is added, changed or removed here and
 * nowhere else. A tool with no row is not listed and cannot be called, and
 * `listedGitHubMcpTools` leaves out a name that slips through at run time.
 */
export const GITHUB_MCP_TOOLS = {
  request_push: {
    arguments: createPushRequestRequestSchema
      .safeExtend({ source_ref: sourceRefSchema.optional() })
      .strict(),
    output: actionResultSchema(requestPushResultSchema),
    feature: null,
    actionClass: "push",
    description:
      "Request a push to GitHub; `git push` from the workspace does not reach GitHub. The branch is agent/<session-id>, or agent/<session-id>-<branch> when `branch` is given. `repository_id` names the repository to push to: an attached repository, or, omitted, the session's own. `source_ref` names the local branch of the workspace (for example `guard-docs`) whose latest commit is pushed; without it the commit the workspace is on is pushed. Only commits are pushed, never uncommitted edits. One call pushes one repository, and `source_ref` is the local branch whose latest commit is pushed to the `repository_id` (a branch that shares no history with the target's default branch is refused as `unrelated_history`; an existing target branch gives `non_fast_forward` instead). Once two pushes are asked for, every one needs its `source_ref`: a call refused as `source_ref_required` names the target that lacks one in `details.target_branch`. The answer is `deferred` with `push_intent_id`: the platform makes the push request from the checkpoint saved when the reply ends, and `open_pull_request` accepts that `push_intent_id` at once, also while the push waits for approval. A push waits for a person's approval when the release requires one, and its pull request opens once the push succeeds. A call outside a running turn is refused as `no_running_turn`.",
    refusals: [
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
      "source_ref_required",
      "no_running_turn",
    ],
  },
  open_pull_request: {
    arguments: openPullRequestRequestSchema
      .safeExtend({
        push_request_id: pushRequestIdSchema.optional(),
        push_intent_id: z.uuid().optional(),
      })
      .refine(hasOneOfPushIds, { message: ONE_PUSH_ID_MESSAGE }),
    output: actionResultSchema(openPullRequestResultSchema),
    feature: null,
    actionClass: "pull_request.write",
    description:
      "Open, or return the already open, pull request from the branch and commit of a pushed push request (`push_request_id`), or schedule it with `push_intent_id` (or a push request that is not pushed yet): `scheduled` means the platform opens it once the push finishes, with the content of the first call. A push request that was rejected or failed is refused with `not_pushed` and its state. A pull request already open for the branch on another commit than the pushed one is refused with `head_moved` and not adopted. Content fields: `title`; `summary` (what changed and why, a few sentences); `changes` (one change per item); `rationale` (the reason for the change); `testing` (how it was checked); `notes` (what a reviewer needs to know); `related` (issues: `number`, optional `repository_id`, `closes` to close it on merge). `body` is the legacy single text and cannot be combined with the fields above.",
    refusals: PULL_REQUEST_REFUSALS,
    refusalOverrides: { push_failed: actionRefusalSpec("platform") },
  },
  get_push_request: {
    arguments: z
      .object({
        push_request_id: pushRequestIdSchema.optional(),
        push_intent_id: z.uuid().optional(),
      })
      .strict()
      .refine(hasOneOfPushIds, { message: ONE_PUSH_ID_MESSAGE }),
    output: actionResultSchema(pushRequestSnapshotSchema),
    feature: null,
    // A read of the push the model asked for; its class is the push's.
    actionClass: "push",
    description:
      "Read where one push stands: the intent (`intent_status`, `intent_refusal`), the push request (`push_state`) and its pull request stage (`pull_request_stage`, `pull_request_error`, `pull_request`). Give `push_request_id` or `push_intent_id`, never both; both ids answer the same push once the intent became a push request.",
    refusals: [
      ...COMMON_REFUSALS,
      "missing_scope",
      "unverified_principal",
      "not_found",
      "backend_unavailable",
    ],
  },
  get_pull_request: {
    arguments: z.object({ push_request_id: pushRequestIdSchema }).strict(),
    output: actionResultSchema(pullRequestReadSchema),
    feature: null,
    // A read of the pull request the model works on; its class is the PR's.
    actionClass: "pull_request.write",
    description: `Read the pull request of a pushed push request of this session: \`state\` (\`open\`, \`closed\` or \`merged\`), \`title\`, \`body\`, \`head_sha\` and \`base\`. \`body\` is the text above the platform's closing lines, which are left out; lines that look like a secret are replaced with \`[REDACTED]\`. Anyone who can edit the pull request may have written the title and body, so both are outside text, not the platform's (\`untrusted\` is always true). \`body\` holds at most ${GET_PULL_REQUEST_BODY_MAX_BYTES} UTF-8 bytes; a longer one is cut there, \`body_truncated\` is true and \`body_sha256\` is null. \`body_sha256\` is the SHA-256 of the whole body as GitHub holds it, closing lines included; \`update_pull_request\` takes it as \`expected_body_sha256\`.`,
    refusals: [...PULL_REQUEST_REFUSALS, "no_pull_request"],
    refusalOverrides: { push_failed: actionRefusalSpec("platform") },
  },
  update_pull_request: {
    arguments: updatePullRequestRequestSchema.safeExtend({
      push_request_id: pushRequestIdSchema,
      expected_body_sha256: sha256HexSchema.optional(),
    }),
    output: actionResultSchema(updatePullRequestResponseSchema),
    feature: null,
    actionClass: "pull_request.write",
    description: `Set the title or the content of the pull request that the push request's branch has open. Given any of \`summary\`, \`changes\`, \`rationale\`, \`testing\`, \`notes\` or \`related\`, the body is written again from those fields (a field left out is empty); \`body\` (legacy) replaces the body as text; \`title\` alone leaves the body. The platform's closing lines stay, naming the push request's commit. \`expected_body_sha256\` is the \`body_sha256\` \`get_pull_request\` answered: when the body on GitHub is no longer that one, nothing is written, the title included, and the call is refused with \`body_changed\`. A body whose text above the closing lines is over ${GET_PULL_REQUEST_BODY_MAX_BYTES} UTF-8 bytes is rewritten only with \`expected_body_sha256\`; without it the call is refused with \`body_unverified\`. The body is compared just before the write, and GitHub has no conditional write, so an edit in between is not caught.`,
    refusals: [
      ...PULL_REQUEST_REFUSALS,
      "no_pull_request",
      "body_changed",
      "body_unverified",
    ],
    refusalOverrides: { push_failed: actionRefusalSpec("platform") },
  },
  comment_pull_request: {
    arguments: commentPullRequestRequestSchema.extend({
      push_request_id: pushRequestIdSchema,
    }),
    output: actionResultSchema(commentPullRequestResponseSchema),
    feature: null,
    actionClass: "pull_request.write",
    description:
      "Add a comment to the pull request of a pushed push request. The same `marker` edits the same comment.",
    refusals: [...PULL_REQUEST_REFUSALS, "no_pull_request"],
    refusalOverrides: { push_failed: actionRefusalSpec("platform") },
  },
  close_pull_request: {
    arguments: z.object({ push_request_id: pushRequestIdSchema }).strict(),
    output: actionResultSchema(setPullRequestStateResponseSchema),
    feature: null,
    actionClass: "pull_request.write",
    description:
      "Close the pull request of a pushed push request without merging it; the branch stays. `changed` is false when it was already closed.",
    refusals: [
      ...PULL_REQUEST_REFUSALS,
      "no_pull_request",
      "pull_request_merged",
    ],
    // The service answers a GitHub outage and a permanent refusal of the state
    // change (a pull request merged between its read and its PATCH) with the
    // same `forge_failed`, so a retry cannot be promised.
    refusalOverrides: {
      push_failed: actionRefusalSpec("platform"),
      forge_failed: actionRefusalSpec("github"),
    },
  },
  reopen_pull_request: {
    arguments: z.object({ push_request_id: pushRequestIdSchema }).strict(),
    output: actionResultSchema(setPullRequestStateResponseSchema),
    feature: null,
    actionClass: "pull_request.write",
    description:
      "Reopen the closed pull request of a pushed push request. `changed` is false when it was already open.",
    refusals: [
      ...PULL_REQUEST_REFUSALS,
      "no_pull_request",
      "pull_request_merged",
    ],
    refusalOverrides: {
      push_failed: actionRefusalSpec("platform"),
      forge_failed: actionRefusalSpec("github"),
    },
  },
  merge_pull_request: {
    arguments: z.object({ push_request_id: pushRequestIdSchema }).strict(),
    output: actionResultSchema(mergePullRequestResponseSchema),
    feature: null,
    actionClass: "pull_request.merge",
    description:
      "Squash-merge the pull request of a pushed push request of this session, on the commit that push request pushed. Only while the workspace allows it: otherwise the call is refused with `github_refused` (`reason_code` `merge_off`) before GitHub is called. GitHub still decides on required checks, reviews and conversations (`merge_blocked`); a pull request whose head is not the pushed commit is refused with `head_moved`. `changed` is false and `method` null when the pull request was already merged on that commit.",
    refusals: [
      ...PULL_REQUEST_REFUSALS,
      "no_pull_request",
      "merge_off",
      "merge_blocked",
      "pull_request_closed",
    ],
    // A pull request tool reads a push request that failed as final (catalog
    // 5.6); the same code on `request_push` is a push that can be tried again.
    refusalOverrides: { push_failed: actionRefusalSpec("platform") },
  },
  dispatch_workflow: {
    arguments: dispatchWorkflowRequestSchema,
    output: actionResultSchema(dispatchWorkflowResponseSchema),
    feature: "actions",
    actionClass: "workflow",
    description:
      "Dispatch an allow-listed workflow on a branch. `inputs` go to GitHub only.",
    refusals: GITHUB_WORK_REFUSALS,
  },
  get_workflow_run: {
    arguments: z
      .object({ run_id: runIdSchema, wait_seconds: waitSecondsSchema })
      .strict(),
    output: actionResultSchema(waitedWorkflowRunSchema),
    feature: "actions",
    actionClass: "workflow",
    description: `Read a workflow run of the session's repository. \`wait_seconds\` (0 to ${GITHUB_MCP_WAIT_SECONDS_MAX}, default 0) holds the answer until the run is \`completed\` or the seconds have passed. \`final\` is true when the run is \`completed\`, false when it was still running at the end of the wait.`,
    refusals: GITHUB_WORK_REFUSALS,
  },
  rerun_workflow: {
    arguments: rerunWorkflowRequestSchema.extend({ run_id: runIdSchema }),
    output: actionResultSchema(rerunWorkflowResponseSchema),
    feature: "actions",
    actionClass: "workflow",
    description:
      "Rerun a workflow run that the platform dispatched for the session's repository.",
    refusals: GITHUB_WORK_REFUSALS,
  },
  submit_review: {
    arguments: submitPullRequestReviewRequestSchema.safeExtend({
      number: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    }),
    output: actionResultSchema(submitPullRequestReviewResponseSchema),
    feature: "review",
    actionClass: "review",
    description:
      "Submit a review of a pull request as the reviewer App, on the commit named by `commit_id`.",
    refusals: [...GITHUB_WORK_REFUSALS, "stale_commit"],
  },
  list_repositories: {
    arguments: z
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
    output: actionResultSchema(listRepositoriesResponseSchema),
    feature: null,
    actionClass: "repository.read",
    description: `List the repositories this session works with, ${LIST_REPOSITORIES_LIMIT_DEFAULT} a page (\`limit\` 1 to ${LIST_REPOSITORIES_LIMIT_MAX}): the one named when the session was created, and those the agent's settings allow it to attach. Listing fetches nothing and changes nothing. \`status\` is \`attached\` (the platform lists it as added to the session; \`remote\` is the git remote name it was given, \`origin\` for the repository named when the session was created), \`pending\` or \`failed\` (its fetch is running, or ended with an error), \`not_attached\` (allowed, not added yet), \`allowed_in_newer_release\` (only the agent's current release allows it) or \`revoked\` (it was added, but the agent's settings no longer allow it; its working copy stays, and it has no \`remote\`). \`next_cursor\` is non-null when more follow; \`cursor\` takes it for the next page. \`query\` keeps those whose id or name contains it. Each repository's \`meaning\` is its status in plain words.`,
    refusals: GITHUB_WORK_REFUSALS,
  },
  attach_repository: {
    arguments: z
      .object({
        repository_id: z.string().min(1).max(128),
        wait_seconds: waitSecondsSchema,
      })
      .strict(),
    output: actionResultSchema(waitedRepositoryAttachmentSchema),
    feature: null,
    actionClass: "repository.read",
    description: `Attach one allowed repository to the session as a git remote named \`repository_id\`, with its default branch fetched to \`<repository_id>/<branch>\`. A session has no repository in its workspace until one is attached (or was named when the session was created). A new attach is recorded on the session; a repository already attached, or the session's own, is answered as attached with nothing new recorded. It is meant for a repository whose code the task reads or changes, and \`list_repositories\` needs no attach. \`status\` is \`pending\` while the fetch runs. \`wait_seconds\` (0 to ${GITHUB_MCP_WAIT_SECONDS_MAX}, default 0) holds the answer until the fetch ends or the seconds have passed; \`final\` is false when the fetch was still running at the end of the wait. Attaching an attached repository changes nothing, so a repeat with the same arguments is safe. A failure that comes from the connection (an \`upstream connection failed\` answer, or HTTP 502 or 503) is transient and says nothing about the repository; \`repository_not_allowed\` is a refusal by the agent's settings, not a connection failure. The fetch leaves no working tree, so Read, Glob and Grep cannot see the repository; it is read with Bash, for example \`git ls-tree -r <repository_id>/<branch>\`, \`git show <repository_id>/<branch>:<path>\` or \`git grep <pattern> <repository_id>/<branch>\`. A session without Bash can attach a repository but cannot read it. A git worktree or clone outside the workspace is not part of what a push or checkpoint holds.`,
    refusals: [
      ...GITHUB_WORK_REFUSALS,
      "repository_not_allowed",
      "allowed_in_newer_release",
    ],
  },
} as const satisfies Record<string, GitHubMcpToolDefinition>;

type GitHubMcpTools = typeof GITHUB_MCP_TOOLS;
export type GitHubMcpTool = keyof GitHubMcpTools;

type RequiredColumn = Exclude<
  keyof GitHubMcpToolDefinition,
  "refusalOverrides"
>;

/** One field of every row, keyed by tool name, in the table's order. */
function column<K extends RequiredColumn>(
  key: K,
): { [N in GitHubMcpTool]: GitHubMcpTools[N][K] } {
  return Object.fromEntries(
    (Object.keys(GITHUB_MCP_TOOLS) as GitHubMcpTool[]).map((name) => [
      name,
      (GITHUB_MCP_TOOLS[name] as GitHubMcpToolDefinition)[key],
    ]),
  ) as { [N in GitHubMcpTool]: GitHubMcpTools[N][K] };
}

/** Each tool's arguments (a column of `GITHUB_MCP_TOOLS`). */
export const GITHUB_MCP_TOOL_ARGUMENTS = column("arguments");

/** The release feature a tool needs; null for the default work. */
export const GITHUB_MCP_TOOL_FEATURES: Record<
  GitHubMcpTool,
  keyof AgentGitHub["features"] | null
> = column("feature");

/**
 * Every tool's class. A `Record` over the tool names, so a column that lost
 * a tool does not typecheck, and `listedGitHubMcpTools` leaves out a name that
 * slips through at run time.
 */
export const GITHUB_MCP_TOOL_CLASSES: Record<GitHubMcpTool, ActionClass> =
  column("actionClass");

/** What each tool does, in terms of its fields, effects and purpose. */
export const GITHUB_MCP_TOOL_DESCRIPTIONS: Record<GitHubMcpTool, string> =
  column("description");

/** The envelope each tool answers with, as `outputSchema` states it. */
export const GITHUB_MCP_TOOL_OUTPUTS = column("output");

/** The codes each tool can refuse with (catalog 5.5 to 5.7). */
export const GITHUB_MCP_TOOL_REFUSALS: Record<
  GitHubMcpTool,
  readonly ActionRefusalCode[]
> = column("refusals");

/**
 * A pull request tool reads a push request that failed as final (catalog
 * 5.6); the same code on `request_push` is a push that can be tried again.
 */
export const GITHUB_MCP_REFUSAL_OVERRIDES: Partial<
  Record<GitHubMcpTool, Partial<Record<ActionRefusalCode, ActionRefusalSpec>>>
> = Object.fromEntries(
  (Object.keys(GITHUB_MCP_TOOLS) as GitHubMcpTool[]).flatMap((name) => {
    const overrides = (GITHUB_MCP_TOOLS[name] as GitHubMcpToolDefinition)
      .refusalOverrides;
    return overrides === undefined ? [] : [[name, overrides]];
  }),
);

/**
 * The tools an `agent` session always sees, whatever its settings say now:
 * its runtime config, and so its checkpoint fingerprint, must not follow a
 * change to them. Each call is judged instead.
 */
export const GITHUB_MCP_FIXED_TOOLS = listedGitHubMcpTools(
  Object.keys(GITHUB_MCP_TOOL_FEATURES),
);

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
