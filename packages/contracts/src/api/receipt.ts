import { z } from "zod";

import {
  type EffectiveGitHubPolicy,
  GITHUB_POLICY_SOURCE_VALUES,
} from "../kollegium/agents.ts";
import {
  receiptActorSchema,
  resourceRefSchema,
} from "../musterrolle/authorization.ts";
import {
  apiErrorCodeSchema,
  receiptIdSchema,
  requestIdSchema,
  revisionSchema,
  sessionIdSchema,
  timestampSchema,
  turnIdSchema,
  userIdSchema,
  workspaceIdSchema,
} from "../shared/index.ts";

export const RECEIPT_STATUS_VALUES = [
  "accepted",
  "succeeded",
  "failed",
  "unknown",
] as const;
export const RECEIPT_OPERATION_VALUES = [
  "create_session",
  "append_message",
  "answer",
  "interrupt",
  "pause",
  // The owner's ordinary close, distinct from terminate and from an
  // operator's recovery close (recovery_decision).
  "close",
  "terminate",
  "resume",
  "recovery_decision",
  // A session moved onto another catalog profile from its next turn on.
  "change_profile",
  // The operator's execution revocation; written on the session
  // owner's receipt list so the owner sees why the session stopped.
  "revoke_execution",
  // Account recovery (94S-264): a one-time link issued and the password set
  // from it, and an owner added or restored by BOOTSTRAP_TOKEN when no live
  // owner remained.
  "issue_password_reset",
  "reset_password",
  "recover_owner",
  // An owner taking over a session whose requester was offboarded.
  "takeover",
  // A person linking or unlinking their own Slack account.
  "link_account",
  "unlink_account",
  // Invites and roles (94S-153).
  "invite_member",
  "accept_invite",
  "revoke_invite",
  "change_member_role",
  // Turning a membership or a whole account off and back on (94S-464).
  "disable_member",
  "enable_member",
  "disable_user",
  "enable_user",
  "create_agent",
  "update_agent",
  "create_agent_release",
  "activate_agent",
  // Issuing and revoking an API key from the web or the API (94S-574).
  "create_api_key",
  "revoke_api_key",
  // Teams and who administers an agent (94S-582). Adding a member writes its
  // receipt on that member, so it is also their notice of the change.
  "create_team",
  "rename_team",
  "delete_team",
  "add_team_member",
  "remove_team_member",
  "set_team_member_role",
  "set_agent_managing_team",
  // The workspace's two agent access settings (agent-rbac (c)).
  "set_agent_access_settings",
  "add_agent_admin",
  "remove_agent_admin",
  // Binding a credential name to an agent and taking it off (94S-581).
  "bind_credential",
  "unbind_credential",
  // Pinning an agent to its Slack app and bot, and taking that back (M8).
  "link_agent_identity",
  "revoke_agent_identity",
  // Setting how an agent answers in one Slack channel or its DMs (94S-177).
  "set_surface_binding",
  "request_surface_binding",
  "resolve_surface_binding",
  // Changing who sees a session (94S-584).
  "share_session",
  // A push request, a human's decision on one (or a refused attempt at
  // either), and the platform's push of an approved one.
  "request_push",
  "resolve_push",
  // `resolve_push` in receipts written before the rename.
  "decide_push",
  "push",
  "open_pull_request",
  "update_pull_request",
  "comment_pull_request",
  "close_pull_request",
  "reopen_pull_request",
  "merge_pull_request",
  // A remote MCP exchange the egress proxy refused for the agent's
  // credential: unbound, not for this workspace, or moved in the catalog.
  "call_mcp",
  // A Slack secret set, replaced or deleted through the API; the receipt
  // names its purpose and last four characters, never the value.
  "set_slack_secret",
  "delete_slack_secret",
  // The workspace's GitHub App registered, replaced or removed; the receipt
  // names the App id, never the key.
  "set_github_app",
  "delete_github_app",
  // A GitHub token issued afresh for a session's work, or refused before it.
  "mint_github_token",
  "set_github_ceiling",
  // How the workspace's pull request bodies are laid out; the receipt keeps a
  // template's hash and size, never its text.
  "set_github_pull_request_settings",
  "set_agent_pull_request_settings",
  // A GitHub App repository added to the catalog from the console, its
  // default branch changed, removed, or seeded.
  // Console adds and removes are gone; their receipts stay readable.
  "add_repository",
  "set_repository_branch",
  "remove_repository",
  "import_repository",
  // A provider connection or remote MCP server brought in by a settings
  // document; the receipt names references, never a value.
  "import_connection",
  "import_mcp_server",
  // The console's writes to the same rows: made with a value the owner
  // typed, a value replaced, disabled for good, an MCP server's workspaces.
  // A PAT or public repository reuses add_repository and remove_repository.
  "create_connection",
  "create_mcp_server",
  "set_settings_credential",
  "disable_connection",
  "enable_connection",
  "disable_mcp_server",
  "set_mcp_server_workspaces",
  // An agent's pick resolved a GitHub App repository to a new catalog row.
  "resolve_repository",
  // An agent's GitHub switch turned on or off.
  "set_agent_github",
  // An agent's MCP settings saved; names only, never a credential value.
  "set_agent_mcp",
  // A catalog repository pinned to a GitHub App connection by a pick or an
  // admin (decision github-agent.md 11).
  "set_repository_github_app",
  "review_pull_request",
  "dispatch_workflow",
  "rerun_workflow",
  // A session's agent attaching another repository mid-session
  // (session-repository-attachment.md decision 3).
  "attach_repository",
  // The workspace's GitHub Packages bot token and package allowlist; the
  // receipt names the token's last four characters, never the value.
  "set_github_packages_token",
  "delete_github_packages_token",
  "set_github_packages_allowlist",
  // One GitHub Packages request through the egress proxy, allowed or refused.
  "fetch_github_package",
  "create_workspace_profile",
  "retire_workspace_profile",
  "create_installation_profile",
  "retire_installation_profile",
  "block_installation_profile",
  "unblock_installation_profile",
  // Achievement rules: ids and versions only, never a definition's text.
  "create_achievement_category",
  "update_achievement_category",
  "archive_achievement_category",
  "create_achievement_type",
  "update_achievement_type",
  "archive_achievement_type",
  "create_achievement_rule",
  "update_achievement_rule",
  "disable_achievement_rule",
  "enable_achievement_rule",
  "set_achievement_judge",
  "rejudge_session",
  "review_achievement",
  // User variables (E-41). Names, kinds and versions only: a value is never
  // written, and a plain variable's session record keeps a keyed hash.
  "set_env_variable",
  "delete_env_variable",
  "set_env_variable_grants",
  "resolve_session_env",
  "reject_session_env",
  // Skill-only extension bundles (94S-865). Names, digests and review states
  // only; a bundle's files are never written to a receipt.
  "register_extension",
  "approve_extension",
  "attach_extension",
  "detach_extension",
] as const;

export const receiptStatusSchema = z.enum(RECEIPT_STATUS_VALUES);
export const receiptOperationSchema = z.enum(RECEIPT_OPERATION_VALUES);
// The alpha shape, unchanged: every session operation still answers with
// exactly these three fields.
// Strict on both sides, so a target can only ever be one of the two: a value
// carrying both shapes would otherwise match the session branch and have its
// resource fields silently stripped. It also matches what the generated
// OpenAPI already promised (`additionalProperties: false`).
export const receiptSessionTargetSchema = z
  .object({
    session_id: sessionIdSchema,
    turn_id: turnIdSchema.nullable(),
    request_id: requestIdSchema.nullable(),
  })
  .strict();
// Mutations outside a session — invites, agents, releases, dispatches, memory,
// routines — name their resource instead. Each route adds its own
// `operation` value in its own ticket; the vocabulary here stays session-only
// until one does.
export const receiptResourceTargetSchema = z
  .object({
    resource: resourceRefSchema,
    workspace_id: workspaceIdSchema.nullable(),
  })
  .strict();
// A user is not a grantable resource, so it has its own variant instead of a
// resource kind.
export const receiptUserTargetSchema = z
  .object({
    user_id: userIdSchema,
    workspace_id: workspaceIdSchema,
  })
  .strict();
export const receiptTargetSchema = z.union([
  receiptSessionTargetSchema,
  receiptResourceTargetSchema,
  receiptUserTargetSchema,
]);
export const receiptErrorSchema = z.object({
  code: apiErrorCodeSchema,
  message: z.string().min(1),
});
export const receiptSchema = z.object({
  id: receiptIdSchema,
  operation: receiptOperationSchema,
  target_ref: receiptTargetSchema,
  // Who asked for this. Legacy alpha rows have no actor to report.
  actor: receiptActorSchema.optional(),
  status: receiptStatusSchema,
  // Input receipts keep the acceptance response for good, because a retry
  // with the same Idempotency-Key replays exactly that body (api.md, common
  // rules). Every writer that settles one — finalize, execution gone,
  // terminate, recovery decisions — changes `status` and `error` only.
  result: z.unknown().nullable().meta({
    description:
      "For create_session and append_message: the acceptance response exactly as first returned, never rewritten; its receipt_status and status are acceptance-time values. The current outcome is this receipt's status and error; the turn's result is read from GET /v1/sessions/{session_id}/turns/{turn_id} using target_ref. For interrupt: `{turn_id, terminal, no_op}` once settled, where `no_op: true` means the turn reached `terminal` on its own and the interrupt did nothing.",
  }),
  error: receiptErrorSchema.nullable(),
  created_at: timestampSchema,
  updated_at: timestampSchema,
});
export const getReceiptResponseSchema = receiptSchema;

export const receiptAcceptedResponseSchema = z.object({
  receipt_id: receiptIdSchema,
  receipt_status: receiptStatusSchema,
});

/**
 * What the receipt of a session's GitHub work adds to `agent_release_id`:
 * the policy that decided, which under an `agent` session is not the
 * release. Absent on receipts from before, which read as `release`.
 */
export const githubPolicyReceiptFieldsSchema = z.object({
  policy_source: z.enum(GITHUB_POLICY_SOURCE_VALUES).optional(),
  agent_settings_revision: z.number().int().nullable().optional(),
  workspace_ceiling_revision: z.number().int().nullable().optional(),
});
export type GitHubPolicyReceiptFields = z.infer<
  typeof githubPolicyReceiptFieldsSchema
>;

export function githubPolicyReceiptFields(
  policy: EffectiveGitHubPolicy,
  ceilingRevision: number,
): GitHubPolicyReceiptFields {
  return {
    policy_source: policy.source,
    agent_settings_revision: policy.agentSettingsRevision,
    workspace_ceiling_revision: ceilingRevision,
  };
}

export const terminateReceiptResultSchema = z.object({
  execution_gone: z.boolean(),
  checkpoint_revision: revisionSchema.nullable(),
  unconfirmed_turn_id: turnIdSchema.nullable(),
  // A kill removes the execution; whatever it already did outside (commits,
  // pushes, API calls) stays done. The receipt says so instead of letting
  // "succeeded" read as a rollback.
  external_effects_reverted: z.literal(false),
});

export type ReceiptStatus = z.infer<typeof receiptStatusSchema>;
export type ReceiptOperation = z.infer<typeof receiptOperationSchema>;
export type ReceiptSessionTarget = z.infer<typeof receiptSessionTargetSchema>;
export type ReceiptResourceTarget = z.infer<typeof receiptResourceTargetSchema>;
export type ReceiptUserTarget = z.infer<typeof receiptUserTargetSchema>;
export type ReceiptTarget = z.infer<typeof receiptTargetSchema>;
export type Receipt = z.infer<typeof receiptSchema>;
export type GetReceiptResponse = z.infer<typeof getReceiptResponseSchema>;
export type ReceiptAcceptedResponse = z.infer<
  typeof receiptAcceptedResponseSchema
>;
export type TerminateReceiptResult = z.infer<
  typeof terminateReceiptResultSchema
>;
