import { z } from "zod";

/**
 * The result envelope of every tool the action-broker serves (decision
 * action-broker.md §4). A tool answers `{ ok: true, result }` or
 * `{ ok: false, refusal }`. There is no `message`: what a refusal means is
 * its `code`, who refused is `by`, and `details` carries ids, limits and
 * outside text as data.
 */
export const ACTION_REFUSAL_BY_VALUES = [
  "policy",
  "person",
  "platform",
  "github",
] as const;
export const actionRefusalBySchema = z.enum(ACTION_REFUSAL_BY_VALUES);
export type ActionRefusalBy = z.infer<typeof actionRefusalBySchema>;

export const ACTION_REFUSAL_CODE_PATTERN = /^[a-z][a-z0-9_]{1,63}$/;

export const actionRefusalSchema = z
  .object({
    code: z.string().regex(ACTION_REFUSAL_CODE_PATTERN),
    by: actionRefusalBySchema,
    // True only when the same call, unchanged, can succeed later.
    retryable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type ActionRefusal = z.infer<typeof actionRefusalSchema>;

/** The envelope around one tool's result schema. */
export function actionResultSchema<T extends z.ZodType>(result: T) {
  return z.discriminatedUnion("ok", [
    z.object({ ok: z.literal(true), result }).strict(),
    z.object({ ok: z.literal(false), refusal: actionRefusalSchema }).strict(),
  ]);
}
export type ActionResult<T> =
  | { ok: true; result: T }
  | { ok: false; refusal: ActionRefusal };

/** Who refuses under a code, and whether the same call may succeed later. */
export type ActionRefusalSpec = {
  by: ActionRefusalBy;
  retryable: boolean;
};

export const actionRefusalSpec = (
  by: ActionRefusalBy,
  retryable = false,
): ActionRefusalSpec => ({ by, retryable });

const byPlatform = actionRefusalSpec("platform");
const byPolicy = actionRefusalSpec("policy");
const byGitHub = actionRefusalSpec("github");

/**
 * Every refusal code a tool may carry, with the `by` and `retryable` the
 * code fixes (catalog 5.5 to 5.7). A tool lists the codes it can produce; a
 * tool that needs another value for a code overrides it there.
 * `PUSH_REFUSAL_VALUES` and `PULL_REQUEST_REFUSAL_VALUES` keep their names:
 * a new value there needs a row here (the contracts test fails without one).
 */
export const ACTION_REFUSAL_CODES = {
  validation_error: byPlatform,
  internal_error: byPlatform,
  forbidden: byPlatform,
  missing_scope: byPlatform,
  unverified_principal: byPlatform,
  not_found: byPlatform,
  no_checkpoint: byPlatform,
  no_pull_request: byPlatform,
  no_forge: byPlatform,
  catalog_changed: byPlatform,
  github_settings_unsupported: byPlatform,
  no_push_credential: byPlatform,
  already_resolved: byPlatform,
  already_decided: byPlatform,
  checkpoint_moved: byPlatform,
  commit_mismatch: byPlatform,
  unrelated_history: byPlatform,
  // A commit lacks the attribution the platform issued; the same pinned
  // commit stays refused until the worker remakes it.
  attribution_mismatch: byPlatform,
  uncommitted_changes: byPlatform,
  approval_required: byPlatform,
  pull_request_merged: byPlatform,
  session_closed: byPlatform,
  // The push request is not `pushed` yet: waiting for a person or running.
  // Calling again can succeed once it is.
  not_pushed: actionRefusalSpec("platform", true),
  checkpoint_unavailable: actionRefusalSpec("platform", true),
  pinned_source_invalid: actionRefusalSpec("platform"),
  // REST `POST /push-requests` without `checkpoint_revision`.
  checkpoint_revision_required: actionRefusalSpec("platform"),
  source_ref_unsupported: actionRefusalSpec("platform"),
  source_ref_required: actionRefusalSpec("platform", true),
  // `request_push` called outside a running turn.
  no_running_turn: actionRefusalSpec("platform"),
  lease_expired: actionRefusalSpec("platform", true),
  push_failed: actionRefusalSpec("platform", true),
  request_open: actionRefusalSpec("platform", true),
  // A later push request to the same target exists; the content belongs there.
  superseded: actionRefusalSpec("platform"),
  // The push intent ended before it became a push request.
  intent_ended: actionRefusalSpec("platform"),
  // The branch's open pull request holds another commit than the push; it was
  // not adopted. A compare GitHub failed ends here too; a head that only lags
  // behind the push is `forge_failed` instead.
  head_moved: byGitHub,
  merge_off: byPolicy,
  // GitHub will not merge it yet (checks, reviews, conversations, conflicts);
  // call again once that changes.
  merge_blocked: actionRefusalSpec("github", true),
  // The pull request was closed without merging; reopen it first.
  pull_request_closed: actionRefusalSpec("platform"),
  // `request_push.pull_request` needs the PR tool trusted in this session;
  // nothing was created. Call request_push without it, then open_pull_request.
  pull_request_needs_tool_call: actionRefusalSpec("platform"),
  no_repository: byPolicy,
  repository_not_allowed: byPolicy,
  allowed_in_newer_release: byPolicy,
  github_disabled: byPolicy,
  feature_off: byPolicy,
  default_branch: byPolicy,
  target_refused: byPolicy,
  self_approval: byPolicy,
  // A person rejected the push; `details.reason` is their words.
  push_rejected: actionRefusalSpec("person"),
  github_refused: byGitHub,
  // The pull request head is no longer the commit the review names.
  stale_commit: byGitHub,
  non_fast_forward: byGitHub,
  forge_failed: actionRefusalSpec("github", true),
  backend_unavailable: actionRefusalSpec("github", true),
} as const satisfies Record<string, ActionRefusalSpec>;
export type ActionRefusalCode = keyof typeof ACTION_REFUSAL_CODES;
