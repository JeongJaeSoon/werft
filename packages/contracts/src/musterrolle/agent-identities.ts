import { z } from "zod";

import { credentialRefSchema } from "../kollegium/agents.ts";
import {
  agentIdSchema,
  receiptIdSchema,
  revisionSchema,
  timestampSchema,
  userIdSchema,
} from "../shared/index.ts";

// "This Slack app and bot is this agent". An identity row
// pins one agent to one Slack install; v1 has the Slack bot only. Rows are
// revoked, never deleted or reopened: linking again makes a new row.

export const AGENT_IDENTITY_PROVIDER_VALUES = ["slack_bot"] as const;
export const agentIdentityProviderSchema = z.enum(
  AGENT_IDENTITY_PROVIDER_VALUES,
);

export const AGENT_IDENTITY_STATUS_VALUES = ["active", "revoked"] as const;
export const agentIdentityStatusSchema = z.enum(AGENT_IDENTITY_STATUS_VALUES);

/**
 * Why a Slack event moves no agent. Every reason is a drop: the event is
 * acknowledged and nothing runs.
 * - `not_installed`: no install for the event's app in that team.
 * - `installation_unverified`: installed, but `auth.test` has not answered.
 * - `installation_revoked`: the app was uninstalled or revoked.
 * - `unidentified`: the install names no agent, now or before.
 * - `identity_revoked`: the install's agent identity was revoked.
 * - `bot_mismatch`: the install now answers as another bot than the one the
 *   identity pinned, so a reinstall needs a new link.
 * - `agent_mismatch`: the event came in for another agent than the one the
 *   app belongs to.
 * - `agent_archived`: the app's agent is archived.
 */
export const SLACK_EVENT_DROP_REASON_VALUES = [
  "not_installed",
  "installation_unverified",
  "installation_revoked",
  "unidentified",
  "identity_revoked",
  "bot_mismatch",
  "agent_mismatch",
  "agent_archived",
] as const;
export const slackEventDropReasonSchema = z.enum(
  SLACK_EVENT_DROP_REASON_VALUES,
);

export const agentIdentityIdSchema = z.uuid();

// Slack's own ids: an app id, a team id, a bot user id.
export const slackIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Z0-9]+$/);

export const agentIdentitySchema = z
  .object({
    id: agentIdentityIdSchema,
    agent_id: agentIdSchema,
    provider: agentIdentityProviderSchema,
    app_id: slackIdSchema,
    team_id: slackIdSchema,
    /** The bot user the install answered as when the identity was linked. */
    bot_user_id: slackIdSchema,
    /** The bot token's name in the secret store, never its value. */
    credential_ref: credentialRefSchema,
    status: agentIdentityStatusSchema,
    revision: revisionSchema,
    created_by: userIdSchema.nullable(),
    created_at: timestampSchema,
    revoked_at: timestampSchema.nullable(),
  })
  .strict();

/** Pins the agent to its Slack app's install in one team. */
export const linkAgentIdentityRequestSchema = z
  .object({
    provider: agentIdentityProviderSchema,
    app_id: slackIdSchema,
    team_id: slackIdSchema,
    credential_ref: credentialRefSchema,
  })
  .strict();

export const linkAgentIdentityResponseSchema = z
  .object({
    agent_identity: agentIdentitySchema,
    receipt_id: receiptIdSchema,
  })
  .strict();

export const AGENT_IDENTITY_LIST_LIMIT = 50;

/** Active first, newest first within each. */
export const listAgentIdentitiesResponseSchema = z
  .object({
    items: z.array(agentIdentitySchema).max(AGENT_IDENTITY_LIST_LIMIT),
  })
  .strict();

export const agentIdentityParamsSchema = z
  .object({ id: agentIdSchema, identity_id: agentIdentityIdSchema })
  .strict();

export const revokeAgentIdentityResponseSchema = z
  .object({
    agent_identity: agentIdentitySchema,
    /** Null when it was already revoked and nothing was written. */
    receipt_id: receiptIdSchema.nullable(),
  })
  .strict();

// Shown as the API's error message, so the web screen says the same.
export const AGENT_IDENTITY_MESSAGES = {
  notInstalled:
    "이 Slack 앱은 이 워크스페이스에 설치·확인되지 않았어요. 앱을 설치한 뒤 다시 연결하세요",
  taken:
    "이 Slack 앱은 다른 에이전트에 연결돼 있어요. 그 연결을 회수한 뒤 다시 연결하세요",
  exists: "이 에이전트는 이미 이 Slack 앱에 연결돼 있어요",
  refInUse:
    "이 자격 이름은 다른 에이전트나 다른 Slack 앱 연결이 쓰고 있어요. 이 앱의 bot token은 전용 이름으로 등록하세요",
} as const;

export type AgentIdentityProvider = z.infer<typeof agentIdentityProviderSchema>;
export type AgentIdentityStatus = z.infer<typeof agentIdentityStatusSchema>;
export type SlackEventDropReason = z.infer<typeof slackEventDropReasonSchema>;
export type AgentIdentity = z.infer<typeof agentIdentitySchema>;
export type LinkAgentIdentityRequest = z.infer<
  typeof linkAgentIdentityRequestSchema
>;
export type LinkAgentIdentityResponse = z.infer<
  typeof linkAgentIdentityResponseSchema
>;
export type ListAgentIdentitiesResponse = z.infer<
  typeof listAgentIdentitiesResponseSchema
>;
export type RevokeAgentIdentityResponse = z.infer<
  typeof revokeAgentIdentityResponseSchema
>;
