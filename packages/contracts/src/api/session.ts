import { z } from "zod";

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
  timestampSchema,
  turnIdSchema,
  userIdSchema,
  workspaceLimitModeSchema,
} from "../shared/index.ts";
import {
  RUNTIME_KIND_VALUES,
  runtimeKindSchema,
} from "../shared/runtime-kind.ts";
import {
  ADDITIONAL_REPOSITORY_ID_PATTERN,
  additionalRepositoryIdUsable,
} from "./push-request.ts";
import { receiptStatusSchema } from "./receipt.ts";

export { RUNTIME_KIND_VALUES, runtimeKindSchema };

export const SESSION_STATUS_VALUES = [
  "queued",
  "running",
  "needs_input",
  "idle",
  "failed",
  "stopped",
] as const;
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
export const ATTEMPT_STATE_VALUES = [
  "allocated",
  "starting",
  "running",
  "draining",
  "exited",
  "lost",
] as const;
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
// Modes in which no tool call waits for a person (`auto` lets a model
// classifier decide instead).
export const UNATTENDED_PERMISSION_MODES = [
  "bypassPermissions",
  "auto",
] as const;
// The unattended modes nothing judges a call in. The API starts a catalog
// naming one only when the installation opts in (docs/operator/api-server.md).
export const OPT_IN_PERMISSION_MODES = ["bypassPermissions"] as const;

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
  profile_id: z.string().min(1),
});
// The worker protocol carries the model in runtime_config instead.
export const sessionRuntimeViewSchema = sessionRuntimeSchema.extend({
  model: z.string().min(1).meta({
    description:
      "The model the session runs: the one named at create, or the profile's default.",
  }),
  // Fixed with the session: changing it in the catalog makes the session
  // CATALOG_MISMATCH rather than run under the new one.
  permission_mode: permissionModeSchema,
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
  // dispatched; input is still queued.
  z.object({
    code: z.literal("BUDGET_EXCEEDED"),
    reason: z.string().min(1),
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
  // The catalog does not allow the session's profile and repository pair as
  // it stands now, or defines the profile with other settings than the
  // session was created with, so no worker will run it; a launch
  // reserved for it fails the session with CATALOG_MISMATCH. Judged on every
  // read: restoring the pair or the settings clears it, and the next message
  // runs again.
  z.object({
    code: z.literal("CATALOG_MISMATCH"),
    reason: z.string().min(1),
  }),
  // The operator blocked the session's profile (`blocked`) or the
  // installation profile its workspace profile narrows (`base_blocked`).
  // Said in place of CATALOG_MISMATCH: new messages are refused with 409
  // PROFILE_BLOCKED until the operator unblocks it, and then run again.
  z.object({
    code: z.literal("PROFILE_BLOCKED"),
    reason: z.string().min(1),
    reason_code: z.enum(["blocked", "base_blocked"]),
    profile_id: z.string().min(1),
  }),
  // Workers claimed with the session's checkpoint kept ending before the
  // restore finished. While retry_at is set the next launch waits
  // for it; null means the limit was reached and the session is held in
  // recovery_required. A deterministic runtime/profile mismatch stops after
  // the first launch with reason incompatible_checkpoint. After the
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
  // the workspace or starting the engine. At the limit start_fresh launches
  // again once the cause is fixed; close ends the session.
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

export const SESSION_ACTIVITY_WINDOW_EVENTS = 500;
export const SESSION_ACTIVITY_TEXT_MAX = 200;
const activityToolName = z.string().meta({
  description: "The tool_use name; empty when the call named none.",
});
const activityToolTarget = z.string().meta({
  description:
    "What the call acts on, the first of its input's `command`, `file_path`, `path`, `pattern`, `url`, `query` or `description` that is a non-empty string; empty when none is.",
});
export const sessionActivitySchema = z.object({
  last: z
    .discriminatedUnion("kind", [
      z.object({
        kind: z.literal("text"),
        text: z
          .string()
          .min(1)
          .meta({
            description: `The first non-blank line of the text, trimmed and cut to ${SESSION_ACTIVITY_TEXT_MAX} code points.`,
          }),
      }),
      z.object({
        kind: z.literal("tool"),
        name: activityToolName,
        target: activityToolTarget,
      }),
    ])
    .nullable()
    .meta({
      description:
        "The newest text with a non-blank line or tool call in the window's `assistant` and `tool_use` events, a subagent's included. Null when the window has neither.",
    }),
  tool_count: z.number().int().nonnegative().meta({
    description: "Distinct tool_use ids called in the window.",
  }),
  error_count: z.number().int().nonnegative().meta({
    description:
      "Of those calls, the ones whose tool_result has `is_error: true`. A call left without a result is not counted.",
  }),
  subagent_count: z.number().int().nonnegative().meta({
    description:
      "Subagent runs in the window: one per `Task` or `Agent` call, and one per call the window's events name as `parent_tool_use_id`, whether or not that call is in the window.",
  }),
  current_tool: z
    .object({
      id: z.string().min(1),
      name: activityToolName,
      target: activityToolTarget,
      state: z.enum(["running", "waiting"]).meta({
        description:
          "`waiting` while a question for the call is unanswered: the session has not moved past `needs_input` since it was asked.",
      }),
      since: timestampSchema.meta({
        description:
          "When the call was made, or for `waiting` when its question was asked.",
      }),
      request: z
        .object({
          kind: z.enum(["permission", "question"]),
          prompt: z
            .string()
            .min(1)
            .nullable()
            .meta({
              description: `For \`question\`, the first question's text, trimmed and cut to ${SESSION_ACTIVITY_TEXT_MAX} code points; null for \`permission\` and for a question with no text.`,
            }),
        })
        .nullable()
        .meta({
          description:
            "What the call waits on: the newest question the session asked for it. Null unless `state` is `waiting`.",
        }),
    })
    .nullable()
    .meta({
      description:
        "The newest call still open: no tool_result yet, and neither a `result` of its turn nor a status of a session that stopped working (anything but `running`, `needs_input`, `interrupting`) came after it. Such a call reads `interrupted` and is never current.",
    }),
  window: z
    .object({
      events: z.number().int().nonnegative(),
      complete: z.boolean().meta({
        description:
          "True when the window holds every event of the session, so the counts are the session's own.",
      }),
      since: timestampSchema.nullable().meta({
        description:
          "When the oldest event of the window was recorded; null for a session with none.",
      }),
    })
    .meta({
      description: `The events the counts read: the session's newest ${SESSION_ACTIVITY_WINDOW_EVENTS} as recorded. They are ordered by \`occurred_at\`, and events at the same instant in the order they were recorded.`,
    }),
});

export const PAUSE_REASON_VALUES = ["awaiting_input"] as const;
export const pauseReasonSchema = z.enum(PAUSE_REASON_VALUES);
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

// Seconds, both optional: the profile's value stands for one left out.
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
  "profile",
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
    digest: z.string().regex(/^[0-9a-f]{64}$/),
    scope: z.enum(SESSION_EXTENSION_SCOPE_VALUES).meta({
      description:
        "The scope that put the bundle on the session: `profile`, `workspace` or `agent` required it, or the session's own request turned an `optional` one on.",
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
    })
    .nullable()
    .default(null)
    .meta({
      description:
        "The agent the session was created for and the release it is pinned to: `release_version_no` is the card version that release runs, `release_label` the release's label (the Asia/Seoul second it was made, as `2026-10-30_14:30:28`, with `-2`, `-3`, … for a later release of the agent in the same second), `release_is_active` whether that release is the agent's active release when read (false while it has none; a session keeps the release it started on). `name` is the agent's name now, not when the session started. Null for a session created without `agent_release_id`.",
    }),
  agent_hidden: z.boolean().default(false).meta({
    description:
      "True when the session has an agent the caller may not use (a private agent outside the caller's teams): `agent` is then null, as are the agent's name and id everywhere else in this session. The session itself is shown as shared. False otherwise, including a session with no agent.",
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
  // Optional like activity; the detail carries the whole wait.
  input_wait: inputWaitSchema.pick({ state: true }).nullable().optional().meta({
    description:
      "Which stage the session's wait for an answer is in; null when it waits on none. `GET /v1/sessions/{id}` says what it waits on. Absent from a server older than the field.",
  }),
  // What the catalog says the session's profile runs, or null when it cannot
  // say: a legacy row with no profile key, or a key the catalog no longer
  // has (detail reports CATALOG_MISMATCH). Never an estimate.
  runtime: sessionRuntimeViewSchema.nullable(),
  model: z.string().min(1).nullable().meta({
    description:
      "The model the session was created to run: the one named at create, else the agent release's card model, else the profile's default. Changing the session's profile sets it to the new profile's default. Null for a session from before the field whose model could not be told from its catalog entry.",
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
        "The catalog repositories besides `repository_id` the session works on: those it was created with (`attached_repository_ids` at create) and those its agent attached since with `attach_repository`. The session reaches only those of them its agent release's GitHub settings still list. Null on a session that attaches none (no agent release, or a profile whose `repository_mode` is `none`), and on one created before an omitted list meant `[]`: every repository the release lists, besides its own, is reachable. Absent from a server older than the field.",
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
  last_event_at: timestampSchema.nullable(),
  // Optional, not defaulted: a summary built before it existed stays valid.
  activity: sessionActivitySchema.optional().meta({
    description:
      "What the session's newest events did, for a list card. Absent from a server older than the field.",
  }),
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
  durability: sessionDurabilitySchema,
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

export const createSessionRequestSchema = z
  .object({
    profile_id: z.string().min(1).optional().meta({
      description:
        "The catalog profile the session runs on. Required without `agent_release_id`; with it, omitted means the release's profile, and sent it must be that profile.",
    }),
    title: sessionTitleSchema.optional().meta({
      description: `The session's name. Omitted, it is derived from \`message\`: whitespace and line breaks collapsed to one space, the ends trimmed, and text longer than ${SESSION_TITLE_MAX_GRAPHEMES} characters cut to ${SESSION_TITLE_MAX_GRAPHEMES - 1} and an ellipsis (…). Rename it later with \`PATCH /v1/sessions/{id}\`.`,
    }),
    repository_id: z.string().min(1).optional().meta({
      description:
        "The catalog repository the session works on. Where the catalog judges the pair, required when the profile's `repository_mode` is `required`, refused when it is `none`, either when it is `optional`; a session on the agent's GitHub settings or a workspace-scoped profile is judged by the workspace ceiling and the agent's list instead. Omitted, a session of an agent with GitHub settings starts without a repository and attaches what it needs, a session of an agent with none works on the release's `repository_id` when `agent_release_id` is sent, else starts in an empty workspace with no repository of its own, pushing only to those in `attached_repository_ids`.",
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
        description: `Catalog repositories besides the session's own that it may fetch, push to and open pull requests on. Each one has to be listed in the agent release's GitHub settings (\`github.repositories\`), allowed for the profile, and other than the session's repository; otherwise 403 \`GITHUB_REFUSED\` with \`repository_not_allowed\`, as is any list sent for a session without an agent release, or for a profile whose \`repository_mode\` is \`none\` when the agent has no GitHub settings. A session started without a repository on an \`optional\` profile works on these alone, and names one in each push request. Omitted, the same as \`[]\`: the session starts with none besides its own, and its agent attaches others the release lists with the built-in MCP tool \`attach_repository\` when it needs them.`,
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
          "Turns extension bundles on or off for this session, by the bundle ids the workspace registered. Only a bundle its agent or workspace left `optional` can be named; a `required` one is always on and a `forbidden` one cannot be turned on, else `UNSUPPORTED_CAPABILITY` with `details.reason_code` naming why (`required_removed`, `required_replaced`, `forbidden_revived`, `not_optional`, `bundle_not_found`, `bundle_not_approved`, `skill_name_collision`, `feature_unsupported`, `scripts_need_default_mode`) and `details.bundle` the bundle name. An `optional` bundle not named in `enable` stays off. The resolved list is fixed at create and returned as `extensions`.",
      }),
    message: messageTextSchema,
    // Pins the session to this release of an agent: the session then belongs
    // to that agent, and an agent's key may create it. The run itself still
    // follows profile_id, which has to be the release's profile.
    agent_release_id: agentReleaseIdSchema.optional(),
    model: z.string().min(1).optional().meta({
      description:
        "One of the models the profile offers (its `model` or one of its `models` in the catalog). Omitted, the model of the agent release's card when `agent_release_id` is sent, else the profile's default `model`. Kept until the session's profile is changed, after which the new profile's default `model` runs.",
    }),
    permission_wait: permissionWaitRequestSchema.optional().meta({
      description:
        "How long the session's permission and question requests wait for an answer, in seconds: `park_after_seconds` before the platform parks the turn and frees its worker (0 parks at once), `expire_after_seconds` from the request until it stops taking answers and is denied. Each can only shorten the profile's value (`GET /v1/profiles`, `permission_wait`); a longer one is 400 `PERMISSION_WAIT_ABOVE_PROFILE`. Omitted, the profile's values apply. A request takes the values in force when it is raised.",
    }),
  })
  .strict()
  .refine(
    (body) =>
      body.profile_id !== undefined || body.agent_release_id !== undefined,
    {
      path: ["profile_id"],
      message: "profile_id is required without agent_release_id",
    },
  );
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
    } satisfies Record<SessionStatus, z.ZodType>)
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
export type PermissionMode = z.infer<typeof permissionModeSchema>;
export type SessionRuntime = z.infer<typeof sessionRuntimeSchema>;
export type SessionRuntimeView = z.infer<typeof sessionRuntimeViewSchema>;
export type ExecutionObservation = z.infer<typeof executionObservationSchema>;
export type SessionAttention = z.infer<typeof sessionAttentionSchema>;
export type PauseBlockedReason = z.infer<typeof pauseBlockedReasonSchema>;
export type CloseBlockedReason = z.infer<typeof closeBlockedReasonSchema>;
export type SessionDurability = z.infer<typeof sessionDurabilitySchema>;
export type SessionRepository = z.infer<typeof sessionRepositorySchema>;
export type SessionAttachedRepository = z.infer<
  typeof sessionAttachedRepositorySchema
>;
export type SessionActivity = z.infer<typeof sessionActivitySchema>;
export type SessionSummary = z.infer<typeof sessionSummarySchema>;
export type PauseReason = z.infer<typeof pauseReasonSchema>;
export type InputWaitState = z.infer<typeof inputWaitStateSchema>;
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
