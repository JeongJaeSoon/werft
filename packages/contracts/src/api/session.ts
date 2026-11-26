import { z } from "zod";
import { BUDGET_OWNER_KIND_VALUES } from "../domain/budget.ts";
import { releaseLabelSchema } from "../kollegium/agents.ts";
import { envRefusalSchema } from "../kollegium/env-variables.ts";
import {
  slackPermalinkSchema,
  surfaceKindSchema,
} from "../kollegium/surfaces.ts";
import {
  agentIdSchema,
  agentReleaseIdSchema,
  pageSchema,
  paginationQuerySchema,
  receiptIdSchema,
  requestIdSchema,
  revisionSchema,
  sessionIdSchema,
  sha256HexSchema,
  timestampSchema,
  turnIdSchema,
  userIdSchema,
  workspaceLimitModeSchema,
} from "../shared/index.ts";
import {
  RUNTIME_FIXED_TOOLS,
  RUNTIME_KIND_OF_PROVIDER,
  RUNTIME_KIND_VALUES,
  RUNTIME_KINDS_WITH_AUTO_MODE,
  RUNTIME_SUBAGENT_TOOL,
  runtimeKindSchema,
} from "../shared/runtime-kind.ts";
import {
  ADDITIONAL_REPOSITORY_ID_PATTERN,
  additionalRepositoryIdUsable,
} from "./push-request.ts";
import { receiptStatusSchema } from "./receipt.ts";

export {
  RUNTIME_KIND_OF_PROVIDER,
  RUNTIME_KIND_VALUES,
  RUNTIME_KINDS_WITH_AUTO_MODE,
  RUNTIME_FIXED_TOOLS,
  RUNTIME_SUBAGENT_TOOL,
  runtimeKindSchema,
};

export const SESSION_STATUS_VALUES = [
  "queued",
  "running",
  "needs_input",
  "idle",
  "failed",
  "stopped",
] as const;
/** The statuses a session stays in once it has ended. */
export const ENDED_SESSION_STATUSES = [
  "failed",
  "stopped",
] as const satisfies readonly (typeof SESSION_STATUS_VALUES)[number][];
export const ADMISSION_STATE_VALUES = [
  "active",
  "pausing",
  "paused",
  "resuming",
  "stopping",
  "stopped",
  "recovery_required",
  "closing",
  "closed",
] as const;
// The admissions a session is ended in, whatever its status says.
export const ENDED_ADMISSION_STATES: readonly (typeof ADMISSION_STATE_VALUES)[number][] =
  ["stopping", "stopped", "closing", "closed"];
export const TURN_STATUS_VALUES = [
  "queued",
  "running",
  "needs_input",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "outcome_unknown",
] as const;
export const TERMINAL_TURN_STATUS_VALUES = [
  "completed",
  "failed",
  "interrupted",
  "cancelled",
  "outcome_unknown",
] as const;
/** The rest of the turn statuses: waiting to run, or in flight. */
export const UNFINISHED_TURN_STATUSES = [
  "queued",
  "running",
  "needs_input",
] as const satisfies readonly (typeof TURN_STATUS_VALUES)[number][];
export const ATTEMPT_STATE_VALUES = [
  "allocated",
  "starting",
  "running",
  "draining",
  "exited",
  "lost",
] as const;
/** Typed as plain strings: callers test raw row states against it and pass it to `notInArray`. */
export const ENDED_ATTEMPT_STATES: string[] = [
  "exited",
  "lost",
] satisfies (typeof ATTEMPT_STATE_VALUES)[number][];
export const EXECUTION_STATE_VALUES = [
  "pending",
  "running",
  "suspended",
  "terminating",
  "terminated",
  "unknown",
] as const;
export const EXECUTION_BACKEND_VALUES = [
  "local_docker",
  "kubernetes",
  "lambda_microvm",
] as const;
export const PERMISSION_MODE_VALUES = [
  "default",
  "acceptEdits",
  "dontAsk",
  "plan",
  "bypassPermissions",
  "auto",
] as const;

export const sessionStatusSchema = z.enum(SESSION_STATUS_VALUES);
export const admissionStateSchema = z.enum(ADMISSION_STATE_VALUES);
export const turnStatusSchema = z.enum(TURN_STATUS_VALUES);
export const terminalTurnStatusSchema = z.enum(TERMINAL_TURN_STATUS_VALUES);
export const attemptStateSchema = z.enum(ATTEMPT_STATE_VALUES);
export const executionStateSchema = z.enum(EXECUTION_STATE_VALUES);
export const executionBackendSchema = z.enum(EXECUTION_BACKEND_VALUES);
export const permissionModeSchema = z.enum(PERMISSION_MODE_VALUES);

export const sessionRuntimeSchema = z.object({
  kind: runtimeKindSchema,
  version: z.string().min(1),
  connection_id: z.string().min(1).meta({
    description:
      "The provider connection the session's model is called through, as its agent release named it.",
  }),
});
// The worker protocol carries the model in runtime_config instead.
export const sessionRuntimeViewSchema = sessionRuntimeSchema.extend({
  model: z.string().min(1).meta({
    description:
      "The model the session runs: the one named at create, or its agent release's card model.",
  }),
  // Fixed with the session's spec: a later release does not change it.
  permission_mode: permissionModeSchema,
});
const runtimeCombinationSchema = z.object({
  engine: z.string().min(1),
  sdk_version: z.string().min(1),
  cli_version: z.string().min(1),
  profile_sha256: z.string().min(1),
});
// What the worker images actually ran, as checkpoints recorded it; `runtime`
// is what the release pinned.
export const sessionWorkerRuntimeSchema = z.object({
  first_image: z.string().min(1).nullable().meta({
    description:
      "The worker image pinned for the session's first launch, by digest where the backend resolves one. Null before the first launch, and on a session from before the record.",
  }),
  first: runtimeCombinationSchema.nullable().meta({
    description:
      "The runtime combination of the first checkpoint the session committed with one: the engine, its SDK and CLI versions, and the run settings' digest. Written once. Null before that checkpoint, and on a session from before the record.",
  }),
  checkpoint: runtimeCombinationSchema
    .extend({
      profile_digest_scheme: z.number().int().positive().meta({
        description:
          "How `profile_sha256` was computed. An image restores the checkpoint only when it has the same engine, SDK and CLI versions and still computes this scheme.",
      }),
    })
    .nullable()
    .meta({
      description:
        "The runtime combination of the checkpoint the session's next launch would restore, which the worker image it launches on has to match. Null when no checkpoint would be restored (none committed, or start_fresh retired it), and for a checkpoint committed before the combination was recorded.",
    }),
});
export const executionObservationSchema = z.object({
  backend: executionBackendSchema,
  state: executionStateSchema,
  observed_at: timestampSchema.nullable(),
});
// Why a pause has not reached its safe boundary once the drain deadline has
// passed (api.md § 일시 중지와 저장 상태): a turn still running, a turn
// waiting on a question or approval, a transcript mirror that lost entries,
// or a drain that ended with no committed checkpoint covering the last turn
// that ran. Showing it kills nothing; terminate is the caller's to choose.
export const PAUSE_BLOCKED_REASON_VALUES = [
  "long_turn",
  "pending_request",
  "mirror_error",
  "checkpoint_unavailable",
] as const;
export const pauseBlockedReasonSchema = z.enum(PAUSE_BLOCKED_REASON_VALUES);
// The same for a close, plus `execution_pending`: the worker has released
// and the execution has not been seen gone yet.
export const CLOSE_BLOCKED_REASON_VALUES = [
  ...PAUSE_BLOCKED_REASON_VALUES,
  "execution_pending",
] as const;
export const closeBlockedReasonSchema = z.enum(CLOSE_BLOCKED_REASON_VALUES);
export const TRANSCRIPT_LIMIT_REASON_VALUES = [
  "transcript_near_limit",
  "transcript_too_large",
  "transcript_part_too_large",
] as const;
export const sessionAttentionSchema = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("PAUSE_BLOCKED"),
    reason: pauseBlockedReasonSchema,
  }),
  z.object({
    code: z.literal("CLOSE_BLOCKED"),
    reason: closeBlockedReasonSchema,
  }),
  // The session has spent SESSION_COST_LIMIT_USD or used SESSION_TOKEN_LIMIT
  // tokens, so no further turn is
  // dispatched; input is still queued. With budget_owner, the session's own
  // limit was not reached: the monthly budget account its calls are charged
  // to refused one (the requester's, `user`, or the agent team's, `team`).
  // That one is told until a turn of the session completes after it.
  z.object({
    code: z.literal("BUDGET_EXCEEDED"),
    reason: z.string().min(1),
    budget_owner: z.enum(BUDGET_OWNER_KIND_VALUES).optional(),
  }),
  // A turn ran that no trusted checkpoint covers, so the next worker could
  // only start a new engine session without it. The session is
  // held in recovery_required (or cannot be resumed from stopped) until an
  // operator decides: start_fresh continues without that context, close
  // ends the session.
  z.object({
    code: z.literal("CONTEXT_GAP"),
    last_ran_turn_id: turnIdSchema,
    checkpointed_turn_id: turnIdSchema.nullable(),
  }),
  // The session's connection is disabled or gone, its model left the
  // connection's list, or its repository left the catalog, so no worker will
  // run it; a launch reserved for it fails the session with CATALOG_MISMATCH. Judged on every
  // read: restoring the pair or the settings clears it, and the next message
  // runs again.
  z.object({
    code: z.literal("CATALOG_MISMATCH"),
    reason: z.string().min(1),
  }),
  // Every worker image the installation lists for the session's engine is
  // retracted (runtime_retired), so its next launch has no image to take
  // and its messages wait. Judged on every read: listing an unretracted
  // image of that engine clears it. An engine with no image listed at all
  // reads CATALOG_MISMATCH instead, and a session whose checkpoint only a
  // retracted image restores is stopped and shows RESTORE_FAILED.
  z.object({
    code: z.literal("NO_WORKER_IMAGE"),
    reason: z.enum(["runtime_retired"]),
  }),
  // Workers claimed with the session's checkpoint kept ending before the
  // restore finished. While retry_at is set the next launch waits
  // for it; null means the limit was reached and the session is held in
  // recovery_required. A deterministic runtime mismatch stops after
  // the first launch with reason incompatible_checkpoint, and an engine
  // that lacks a feature the settings need after the first launch with
  // the worker's reason. A checkpoint only a retracted worker image
  // restores stops before any launch with reason runtime_retired. After the
  // cause is fixed, retry_restore tries the same checkpoint again; start_fresh
  // continues without it, close ends the session. A restore that succeeds
  // clears it.
  z.object({
    code: z.literal("RESTORE_FAILED"),
    reason: z.string().min(1),
    failures: z.number().int().positive(),
    retry_at: timestampSchema.nullable(),
  }),
  // The same for a session with no checkpoint to restore
  // workers kept ending before they were ready for input, while preparing
  // the workspace or starting the engine. An engine that lacks a feature
  // the settings need stops it after the first launch. At the limit
  // start_fresh launches again once the cause is fixed; close ends the session.
  z.object({
    code: z.literal("STARTUP_FAILED"),
    reason: z.string().min(1),
    failures: z.number().int().positive(),
    retry_at: timestampSchema.nullable(),
  }),
  // The session's checkpoint transcript is near the limit one checkpoint
  // may carry (transcript_near_limit: the last committed checkpoint is at
  // 80% of it or more), or past it (transcript_too_large, or
  // transcript_part_too_large for a single part). Past it the session takes
  // no new turn: completed turns and the last checkpoint stay, and
  // start_fresh or a new session goes on from there. transcript_bytes is the
  // last committed checkpoint's total; limit_bytes is the limit the reason
  // names (the part limit for transcript_part_too_large).
  z.object({
    code: z.literal("TRANSCRIPT_LIMIT"),
    reason: z.enum(TRANSCRIPT_LIMIT_REASON_VALUES),
    transcript_bytes: z.number().int().nonnegative().nullable(),
    limit_bytes: z.number().int().positive(),
  }),
  // A name the release's card declares no longer reaches the session (deleted,
  // not granted any more, or the runtime cannot carry it), so no worker runs
  // it. It names the cause, never the variable: the requester is not the
  // administrator.
  z.object({
    code: z.literal("VARIABLE_REFUSED"),
    reason: envRefusalSchema,
  }),
  // A Slack message among the sources of one of the session's turns, its
  // own or one it inherited, was deleted. The turn running then finishes
  // and the session stops: it takes no message and does not resume, and
  // close is the only control left. It outranks every other attention.
  z.object({ code: z.literal("SOURCE_DELETED") }),
]);
export const sessionDurabilitySchema = z.object({
  last_transcript_persisted_at: timestampSchema.nullable(),
  checkpoint_committed_at: timestampSchema.nullable(),
  checkpoint_revision: revisionSchema.nullable(),
  last_completed_turn_id: turnIdSchema.nullable(),
  last_checkpointed_turn_id: turnIdSchema.nullable(),
  checkpoint_pending_reason: z.string().min(1).nullable(),
  // The earlier revision the session was last restored from because the
  // checkpoint at checkpoint_revision was damaged. While set, the
  // session holds that revision's state and has lost what the newer ones
  // recorded; the next committed checkpoint clears it.
  checkpoint_fallback_revision: revisionSchema.nullable(),
  // The last turn whose context a start_fresh decision gave up: the engine
  // session running now began after it and does not remember it or anything
  // before. Null while the session has never been reset.
  context_reset_turn_id: turnIdSchema.nullable(),
});

const NEEDS_INPUT_PROJECTION =
  "needs_input is derived when read: a running session or turn with at least one pending request a client can still answer (open, unexpired, raised by the attempt that holds the turn), or an idle session whose turn was parked on requests still open (`input_wait.state: parked`). It returns to running as soon as none is left, whether by an answer, the worker settling the request, expiry or the attempt losing the session, with no change to updated_at. The event stream reports both edges as status events: needs_input right after the question that opened the wait, and the status read here once the wait ends — at the answer or settlement that ended it, or within one reconciler pass when nothing was written (expiry, a lost attempt).";

export const SESSION_TITLE_MAX_GRAPHEMES = 80;
// Bounds the input before it is segmented; a title never needs more.
const SESSION_TITLE_MAX_CHARS = 1024;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Runs of whitespace, line breaks included, become one space; ends trimmed. */
export function normalizeSessionTitle(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function titleGraphemes(text: string): string[] {
  return Array.from(graphemes.segment(text), (part) => part.segment);
}

export const sessionTitleSchema = z
  .string()
  .max(SESSION_TITLE_MAX_CHARS)
  .refine((text) => normalizeSessionTitle(text) !== "", {
    message: "Title is empty once whitespace is collapsed",
  })
  .refine(
    (text) =>
      titleGraphemes(normalizeSessionTitle(text)).length <=
      SESSION_TITLE_MAX_GRAPHEMES,
    {
      message: `Title exceeds ${SESSION_TITLE_MAX_GRAPHEMES} characters`,
    },
  )
  .meta({
    description: `Stored with runs of whitespace and line breaks collapsed to one space and the ends trimmed; at most ${SESSION_TITLE_MAX_GRAPHEMES} characters (grapheme clusters) after that.`,
  });

export const sessionRepositorySchema = z.object({
  id: z.string().min(1).nullable().meta({
    description:
      "The catalog key, as `repository_id`. Null for a session created before the catalog existed.",
  }),
  full_name: z.string().min(1).nullable().meta({
    description:
      "A name to show: the path of the repository's http(s) URL without host, credentials, query or `.git` (`owner/name`, or `group/sub/name`), or else the catalog key; null when neither exists. Never the URL itself, which may embed a credential.",
  }),
  branch: z.string().min(1).meta({
    description:
      "The branch the session's workspace was cloned from. Not the branch a push writes to (`agent/<session-id>`).",
  }),
});

export const sessionAttachedRepositorySchema = z.object({
  id: z.string().min(1).meta({ description: "The catalog key." }),
  full_name: z.string().min(1).nullable().meta({
    description:
      "A name to show, chosen as `repository.full_name` is: the path of the catalog URL's http(s) address, or else the catalog key; null when the catalog no longer lists the repository.",
  }),
});

export const PAUSE_REASON_VALUES = ["awaiting_input"] as const;
export const pauseReasonSchema = z.enum(PAUSE_REASON_VALUES);
/** Why a session's queued input has not started yet. */
export const SESSION_WAIT_REASON_VALUES = ["waiting_for_capacity"] as const;
export const sessionWaitReasonSchema = z.enum(SESSION_WAIT_REASON_VALUES);
export const INPUT_WAIT_STATE_VALUES = [
  "waiting",
  "parking",
  "parked",
  "expired",
] as const;
export const inputWaitStateSchema = z.enum(INPUT_WAIT_STATE_VALUES);
export const PENDING_REQUEST_KIND_VALUES = ["permission", "question"] as const;

export const inputWaitSchema = z
  .object({
    state: inputWaitStateSchema.meta({
      description:
        "`waiting`: a worker holds the turn open on the requests. `parking`: the platform is pausing the session to free its worker, and an answer can still reach the turn before it stops. `parked`: the turn stopped with its checkpoint and the session is paused; answering resumes it. `expired`: every request the parked turn waited on expired unanswered; the session stays paused until someone resumes it.",
    }),
    since: timestampSchema.meta({
      description: "When the oldest of the requests was raised.",
    }),
    kinds: z.array(z.enum(PENDING_REQUEST_KIND_VALUES)).min(1),
    request_ids: z.array(requestIdSchema).min(1),
    park_at: timestampSchema.nullable().meta({
      description:
        "When the platform parks the turn if nobody answers: the earliest of the requests'. Null when none of them parks, so they wait for their worker until they expire.",
    }),
    expires_at: timestampSchema.meta({
      description:
        "When the earliest of the requests stops taking answers. An expired request is denied.",
    }),
  })
  .strict();

// Seconds, both optional: the installation's value stands for one left out.
export const MAX_PERMISSION_WAIT_SECONDS = 604_800;
export const permissionWaitRequestSchema = z
  .object({
    park_after_seconds: z
      .number()
      .int()
      .nonnegative()
      .max(MAX_PERMISSION_WAIT_SECONDS)
      .optional(),
    expire_after_seconds: z
      .number()
      .int()
      .positive()
      .max(MAX_PERMISSION_WAIT_SECONDS)
      .optional(),
  })
  .strict();

export const SESSION_EXTENSION_SCOPE_VALUES = [
  "workspace",
  "agent",
  "session",
] as const;
export const sessionExtensionSchema = z
  .object({
    bundle_id: z.uuid(),
    name: z.string().min(1).meta({
      description:
        "The bundle's plugin slug. Its skills reach the session as `<name>:<skill>`.",
    }),
    digest: sha256HexSchema,
    scope: z.enum(SESSION_EXTENSION_SCOPE_VALUES).meta({
      description:
        "The scope that put the bundle on the session: `workspace` or `agent` required it, or the session's own request turned an `optional` one on.",
    }),
  })
  .strict();
export type SessionExtension = z.infer<typeof sessionExtensionSchema>;

export const sessionSummarySchema = z.object({
  id: sessionIdSchema,
  // Defaults so a reader ahead of its server, during a rollout, reads a
  // summary from before titles as having none.
  title: z
    .string()
    .min(1)
    .nullable()
    .default(null)
    .meta({
      description: `The session's name: the \`title\` it was created or renamed with, or else one derived from its first message (whitespace collapsed, cut to ${SESSION_TITLE_MAX_GRAPHEMES} characters with a trailing ellipsis). Null for sessions created before titles existed and for a first message with no text.`,
    }),
  title_deleted_at: timestampSchema.nullable().default(null).meta({
    description:
      "When Slack deleted the message a derived or generated `title` came from (the first turn's instruction). Set, `title` is null and the session is not found by its words. A title a person gave is kept. Null otherwise, and from a server before the field.",
  }),
  // The three below default to null for the same rollout reason as title.
  agent: z
    .object({
      id: agentIdSchema,
      name: z.string().min(1),
      release_version_no: z.number().int().positive(),
      // Null from a server before release labels, for the rollout reason above.
      release_label: releaseLabelSchema.nullable().default(null),
      // Null from a server before the field, for the same rollout reason.
      release_is_active: z.boolean().nullable().default(null),
      // Null from a server before the field, for the same rollout reason.
      archived: z.boolean().nullable().default(null),
    })
    .nullable()
    .default(null)
    .meta({
      description:
        "The agent the session was created for and the release it is pinned to: `release_version_no` is the card version that release runs, `release_label` the release's label (the Asia/Seoul second it was made, as `2026-10-30_14:30:28`, with `-2`, `-3`, … for a later release of the agent in the same second), `release_is_active` whether that release is the agent's active release when read (false while it has none; a session keeps the release it started on), `archived` whether the agent is archived when read (an archived agent runs no new session; its past sessions keep their agent). `name` is the agent's name now, not when the session started. Null for a session created without `agent_release_id`.",
    }),
  preview: z.boolean().default(false).meta({
    description:
      "True for a preview session: started with `preview: true` by an agent's admin to try a release before publishing it. Fixed at create. False from a server older than the field.",
  }),
  agent_hidden: z.boolean().default(false).meta({
    description:
      "True when the session has an agent the caller is outside of (not an owner or admin, one of the agent's admins or a member of its managing team) or may not use: `agent` is then null, as are the agent's name and id everywhere else in this session. The session itself is shown as shared. An agent still held by the holding team of migration 0243 is named to every live member who can read the session (its `workspace` scope reaches them all); a private, people or team share still decides who reads it, and the agent's own page stays `404` to those outside. False otherwise, including a session with no agent.",
  }),
  created_by: z
    .object({ user_id: userIdSchema, display_name: z.string() })
    .nullable()
    .default(null)
    .meta({
      description:
        "Who started the session: the signed-in person, or for an API key the person who created the key. It stays the same after a takeover hands the session to someone else. Null for sessions from before people were recorded and for a key with no creator.",
    }),
  channel: surfaceKindSchema.nullable().default(null).meta({
    description:
      "Where the request that created the session came from: `web` for the console, `api` for an API key, `slack` for a chat surface. Null for an older session whose creating request cannot be told from what was recorded.",
  }),
  slack_permalink: slackPermalinkSchema.nullable().default(null).meta({
    description:
      "The Slack message that started the session, as the link Slack gave for it (`chat.getPermalink`); it opens only for someone who can read that message in Slack. Null for a session not started from Slack, one from before links were kept, or when Slack did not give a link.",
  }),
  revision: revisionSchema,
  admission_state: admissionStateSchema,
  status: sessionStatusSchema.meta({ description: NEEDS_INPUT_PROJECTION }),
  // Optional, so a summary from an older server parses; the detail carries
  // the whole wait.
  input_wait: inputWaitSchema.pick({ state: true }).nullable().optional().meta({
    description:
      "Which stage the session's wait for an answer is in; null when it waits on none. `GET /v1/sessions/{id}` says what it waits on. Absent from a server older than the field.",
  }),
  wait_reason: sessionWaitReasonSchema.nullable().optional().meta({
    description:
      "Why the session's queued input has not started: `waiting_for_capacity` while its worker waits for room no node has (on Kubernetes, a worker Pod the scheduler marked Unschedulable). After 15 minutes of it the queued input fails with `NO_CAPACITY` and the session waits for its next input. Null when nothing holds it back this way. Absent from a server older than the field.",
  }),
  waiting_since: timestampSchema.nullable().optional().meta({
    description:
      "When the wait `wait_reason` names began; null with it. Absent from a server older than the field.",
  }),
  // What the session's spec runs, or null for a session without one (a
  // legacy row). Never an estimate.
  runtime: sessionRuntimeViewSchema.nullable(),
  model: z.string().min(1).nullable().meta({
    description:
      "The model the session was created to run: the one named at create, else the agent release's card model. Null for a session from before the field.",
  }),
  // Catalog key only. Sessions created before the catalog existed (M0
  // legacy rows) carry no key and surface null; the stored repo URL is
  // never exposed because it may embed credentials.
  repository_id: z.string().min(1).nullable(),
  // Defaults like title, so a reader ahead of its server reads none.
  repository: sessionRepositorySchema.nullable().default(null).meta({
    description:
      "The repository the session was created against, as the session recorded it then: a later catalog change or removal does not alter it. Null for a session created without a repository.",
  }),
  attached_repository_ids: z
    .array(z.string().min(1))
    .nullable()
    .optional()
    .meta({
      description:
        "The catalog repositories besides `repository_id` the session works on: those it was created with (`attached_repository_ids` at create) and those its agent attached since with `attach_repository`. The session reaches only those of them its agent release's GitHub settings still list. Null on a session that attaches none (no agent release), and on one created before an omitted list meant `[]`: every repository the release lists, besides its own, is reachable. Absent from a server older than the field.",
    }),
  attached_repositories: z
    .array(sessionAttachedRepositorySchema)
    .optional()
    .meta({
      description:
        "`attached_repository_ids` with a name for each, in id order. `[]` is a session confirmed to attach none; absent when the server cannot tell (a server older than the field, or a session whose `attached_repository_ids` is null, where the repositories of its agent release may be reachable).",
    }),
  extensions: z.array(sessionExtensionSchema).nullable().optional().meta({
    description:
      "The extension bundles the session runs with, resolved once when it was created: later changes to the workspace's or agent's bundles do not reach it. `[]` is a session that runs with none. Null on a session created before extensions; absent from a server older than the field.",
  }),
  current_turn_id: turnIdSchema.nullable(),
  queued_turn_count: z.number().int().nonnegative(),
  turn_time_ms: z.number().int().nonnegative().default(0).meta({
    description:
      "How long the session's finished turns ran, in milliseconds: the sum of each turn's end minus its start. Time spent idle between turns, waiting for an answer or paused is not counted, and neither is a turn still running. Absent from a server older than the field.",
  }),
  last_turn_cut_off: z.boolean().default(false).meta({
    description:
      "True when the session's last turn failed because its worker lost the session partway (`terminal_reason: worker_ownership_lost`): no turn follows it yet. The session goes on from its last checkpoint with its next input or `POST /v1/sessions/{id}/turns/{turn_id}/continue`. The console shows an `idle` session with this set as cut off. False otherwise, and from a server older than the field.",
  }),
  last_event_at: timestampSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export const sessionDetailSchema = sessionSummarySchema.extend({
  workspace_limit_mode: workspaceLimitModeSchema.optional().meta({
    description:
      "The current attempt's workspace limit classification, recorded by the worker as a system event. Hard is storage enforcement, soft is best effort, unknown is unverified. Absent when no classification was recorded or on older servers; absence means unknown on both axes. This is not usage or an exceedance count.",
  }),
  execution: executionObservationSchema.nullable(),
  checkpoint_revision: revisionSchema.nullable(),
  input_wait: inputWaitSchema.nullable().optional().meta({
    description:
      "The requests the session waits on and the stage of that wait; null when it waits on none. `waiting`, `parking` and `parked` read the requests GET /v1/sessions/{id}/pending-requests lists; `expired` reads the parked turn's requests after the last one expired. Absent from a server older than the field.",
  }),
  pause_reason: pauseReasonSchema.nullable().optional().meta({
    description:
      "Why the platform paused the session: `awaiting_input` while it is `pausing` or `paused` because its turn was parked on requests nobody answered. Null for a pause someone asked for, including one that took a park over, and for every other admission state. Absent from a server older than the field.",
  }),
  pending_request_count: z.number().int().nonnegative().meta({
    description:
      "The requests GET /v1/sessions/{id}/pending-requests lists, counted in the same read as status, parked sessions included: status reads needs_input exactly when this is above zero and the session would otherwise read running or, parked, idle.",
  }),
  attention: sessionAttentionSchema.nullable(),
  start_fresh_available: z.boolean().optional().meta({
    description:
      "Whether `POST /v1/sessions/{id}/recovery-decisions` would take `start_fresh` on the session now, judged on its state alone, not on whether the caller may decide it. True also for a session with no committed checkpoint whose turn ended `outcome_unknown`: start_fresh runs that turn's input again. Absent from a server older than the field.",
  }),
  durability: sessionDurabilitySchema,
  worker_runtime: sessionWorkerRuntimeSchema.optional().meta({
    description:
      "What the session's worker images ran, as recorded at launch and checkpoint; `runtime.version` is instead the version its agent release pinned. Absent from a server older than the field.",
  }),
});

export const MESSAGE_MAX_BYTES = 32 * 1024;
export const PAYLOAD_TOO_LARGE_ISSUE = "PAYLOAD_TOO_LARGE";
export const REQUEST_BODY_MAX_BYTES = 64 * 1024;
const utf8 = new TextEncoder();
export const messageTextSchema = z
  .string()
  .min(1)
  .refine((text) => utf8.encode(text).length <= MESSAGE_MAX_BYTES, {
    message: `Message exceeds ${MESSAGE_MAX_BYTES} UTF-8 bytes`,
    // Lets HTTP handlers answer 413 instead of the generic 400.
    params: { code: PAYLOAD_TOO_LARGE_ISSUE },
  })
  .meta({ description: `At most ${MESSAGE_MAX_BYTES} bytes of UTF-8` });
/**
 * A message a client sends. Stored and queued messages keep
 * `messageTextSchema`, so one written before the blank rule still reads.
 */
export const messageInputSchema = messageTextSchema
  // "" is already refused by the length check; one issue is enough.
  .refine((text) => text === "" || text.trim() !== "", {
    message: "Message is blank",
  })
  .meta({
    description: `At most ${MESSAGE_MAX_BYTES} bytes of UTF-8, not whitespace alone`,
  });

export const createSessionRequestSchema = z
  .object({
    title: sessionTitleSchema.optional().meta({
      description: `The session's name. Omitted, it is derived from \`message\`: whitespace and line breaks collapsed to one space, the ends trimmed, and text longer than ${SESSION_TITLE_MAX_GRAPHEMES} characters cut to ${SESSION_TITLE_MAX_GRAPHEMES - 1} and an ellipsis (…). Rename it later with \`PATCH /v1/sessions/{id}\`.`,
    }),
    repository_id: z.string().min(1).optional().meta({
      description:
        "The catalog repository the session works on, judged by the workspace ceiling and the agent's GitHub settings. Omitted, a session of an agent with GitHub settings starts without a repository and attaches what it needs, a session of an agent with none works on the release's `repository_id` when `agent_release_id` is sent, else starts in an empty workspace with no repository of its own, pushing only to those in `attached_repository_ids`.",
    }),
    attached_repository_ids: z
      .array(
        z
          .string()
          .regex(ADDITIONAL_REPOSITORY_ID_PATTERN)
          .refine(additionalRepositoryIdUsable, {
            message: "Not a repository id a git remote can be named",
          }),
      )
      .refine((ids) => new Set(ids).size === ids.length, {
        message: "attached_repository_ids lists a repository twice",
      })
      .optional()
      .meta({
        description: `Catalog repositories besides the session's own that it may fetch, push to and open pull requests on. Each one has to be listed in the agent release's GitHub settings (\`github.repositories\`), inside the workspace ceiling, and other than the session's repository; otherwise 403 \`GITHUB_REFUSED\` with \`repository_not_allowed\`, as is any list sent for an agent with no GitHub settings. A session started without a repository works on these alone, and names one in each push request. Omitted, the same as \`[]\`: the session starts with none besides its own, and its agent attaches others the release lists with the built-in MCP tool \`attach_repository\` when it needs them.`,
      }),
    extensions: z
      .object({
        enable: z.array(z.uuid()).max(32).optional(),
        disable: z.array(z.uuid()).max(32).optional(),
      })
      .strict()
      .optional()
      .meta({
        description:
          "Turns extension bundles on or off for this session, by the bundle ids the workspace registered. Only a bundle its agent or workspace left `optional` can be named; a `required` one is always on and a `forbidden` one cannot be turned on, else `UNSUPPORTED_CAPABILITY` with `details.reason_code` naming why (`required_removed`, `required_replaced`, `forbidden_revived`, `not_optional`, `bundle_not_found`, `bundle_not_approved`, `no_current_version`, `skill_name_collision`, `feature_unsupported`) and `details.bundle` the bundle name. An attachment that follows a skill's current version uses the version current at create, and is left out (`optional`) or refused with `no_current_version` (`required`) while the skill has none. An `optional` bundle not named in `enable` stays off. The resolved list is fixed at create and returned as `extensions`.",
      }),
    message: messageInputSchema,
    // Pins the session to this release of an agent: the session belongs to
    // that agent, runs the release's spec, and an agent's key may create it.
    agent_release_id: agentReleaseIdSchema,
    model: z.string().min(1).optional().meta({
      description:
        "One of the models the release's connection offers. Omitted, the model of the agent release's card.",
    }),
    preview: z.boolean().optional().meta({
      description:
        "Starts a preview: the agent's admin tries `agent_release_id` before publishing it, including a release never activated. Only a person signed in to the console may send it (400 for an API key or Slack), and only one who manages the release's agent (403 `FORBIDDEN` with `reason_code: role`; someone who cannot see the agent gets 404 as for a release that is not there). The session is shared with its creator alone and cannot be widened (409), every later message and answer needs the sender to still manage the agent, and it counts toward no achievement. Omitted, false.",
    }),
    permission_wait: permissionWaitRequestSchema.optional().meta({
      description:
        "How long the session's permission and question requests wait for an answer, in seconds: `park_after_seconds` before the platform parks the turn and frees its worker (0 parks at once), `expire_after_seconds` from the request until it stops taking answers and is denied. Each can only shorten the installation's value; a longer one is 400 `PERMISSION_WAIT_ABOVE_LIMIT`. Omitted, the installation's values apply. A request takes the values in force when it is raised.",
    }),
  })
  .strict();
export const createSessionResponseSchema = z.object({
  session_id: sessionIdSchema,
  turn_id: turnIdSchema,
  receipt_id: receiptIdSchema,
  receipt_status: receiptStatusSchema,
  status: sessionStatusSchema,
  extensions: z.array(sessionExtensionSchema).optional().meta({
    description:
      "The extension bundles the new session runs with. Absent when the session runs with none.",
  }),
});
export const updateSessionRequestSchema = z
  .object({ title: sessionTitleSchema })
  .strict();
export const SESSION_RELATION_VALUES = [
  "all",
  "started",
  "shared",
  "administered",
] as const;
export const sessionRelationSchema = z.enum(SESSION_RELATION_VALUES);
export const SESSION_SEARCH_MAX_CHARS = 200;
const sessionFilterQuerySchema = z.object({
  relation: sessionRelationSchema.optional().meta({
    description:
      "Narrows the sessions the caller can read, never widens them; omitted, `all`. `started`: the caller started it (for an API key, the key or the person who created it). `shared`: someone else's session shared with the caller by name or through a team the caller is a member of; sessions every workspace member sees appear only under `all`. `administered`: a session of an agent the caller administers, directly or through a team.",
  }),
  q: z.string().trim().min(1).max(SESSION_SEARCH_MAX_CHARS).optional().meta({
    description:
      "Matches a session whose title contains it, ignoring case, or whose id starts with it.",
  }),
});
export const listSessionsQuerySchema = paginationQuerySchema
  .extend({
    status: sessionStatusSchema.optional().meta({
      description:
        "Filters on the status each item reports, needs_input included as derived when read.",
    }),
    last_turn_cut_off: z.enum(["true", "false"]).optional().meta({
      description:
        "Keeps the sessions whose `last_turn_cut_off` is this value. With `status=idle`, `true` lists what `counts.cut_off` counts and `false` the rest of `counts.idle`.",
    }),
    agent_id: agentIdSchema.optional().meta({
      description:
        "Keeps the sessions created for this agent, whichever of its releases they are pinned to. An agent with no session the caller can read, or no such agent, gives an empty page.",
    }),
  })
  .extend(sessionFilterQuerySchema.shape);
export const listSessionsResponseSchema = pageSchema(sessionSummarySchema);
export const countSessionsQuerySchema = sessionFilterQuerySchema;
const sessionCountSchema = z.number().int().nonnegative();
export const countSessionsResponseSchema = z.object({
  counts: z
    .object({
      queued: sessionCountSchema,
      running: sessionCountSchema,
      needs_input: sessionCountSchema,
      idle: sessionCountSchema,
      failed: sessionCountSchema,
      stopped: sessionCountSchema,
      // Defaults so a reader ahead of its server, during a rollout, reads none.
      cut_off: sessionCountSchema.default(0).meta({
        description:
          "How many of the `idle` items have `last_turn_cut_off` set: GET /v1/sessions with `status=idle&last_turn_cut_off=true`. They are counted in `idle` too. Absent from a server older than the field.",
      }),
    } satisfies Record<SessionStatus | "cut_off", z.ZodType>)
    .meta({
      description:
        "For each status, how many items GET /v1/sessions would list with that `status` and the same `relation` and `q`, read to the last page.",
    }),
  total: sessionCountSchema,
});
export const getSessionResponseSchema = sessionDetailSchema;

export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type AdmissionState = z.infer<typeof admissionStateSchema>;
export type TurnStatus = z.infer<typeof turnStatusSchema>;
export type TerminalTurnStatus = z.infer<typeof terminalTurnStatusSchema>;
export type AttemptState = z.infer<typeof attemptStateSchema>;
export type ExecutionState = z.infer<typeof executionStateSchema>;
export type RuntimeKind = z.infer<typeof runtimeKindSchema>;
export type ExecutionBackend = z.infer<typeof executionBackendSchema>;
export type SessionWorkerRuntime = z.infer<typeof sessionWorkerRuntimeSchema>;
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export type SessionRuntime = z.infer<typeof sessionRuntimeSchema>;
export type SessionRuntimeView = z.infer<typeof sessionRuntimeViewSchema>;
export type SessionAttention = z.infer<typeof sessionAttentionSchema>;
export type PauseBlockedReason = z.infer<typeof pauseBlockedReasonSchema>;
export type CloseBlockedReason = z.infer<typeof closeBlockedReasonSchema>;
export type SessionDurability = z.infer<typeof sessionDurabilitySchema>;
export type SessionRepository = z.infer<typeof sessionRepositorySchema>;
export type SessionAttachedRepository = z.infer<
  typeof sessionAttachedRepositorySchema
>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type InputWait = z.infer<typeof inputWaitSchema>;
export type PermissionWaitRequest = z.infer<typeof permissionWaitRequestSchema>;
export type SessionDetail = z.infer<typeof sessionDetailSchema>;
export type CreateSessionRequest = z.infer<typeof createSessionRequestSchema>;
export type CreateSessionResponse = z.infer<typeof createSessionResponseSchema>;
export type UpdateSessionRequest = z.infer<typeof updateSessionRequestSchema>;
export type ListSessionsQuery = z.infer<typeof listSessionsQuerySchema>;
export type ListSessionsResponse = z.infer<typeof listSessionsResponseSchema>;
export type SessionRelation = z.infer<typeof sessionRelationSchema>;
export type CountSessionsQuery = z.infer<typeof countSessionsQuerySchema>;
export type CountSessionsResponse = z.infer<typeof countSessionsResponseSchema>;
export type GetSessionResponse = z.infer<typeof getSessionResponseSchema>;
