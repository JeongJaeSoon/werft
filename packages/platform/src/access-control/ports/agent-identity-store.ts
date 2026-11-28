import type {
  AgentIdentityProvider,
  AgentIdentityStatus,
  SlackEventDropReason,
  WorkspaceRole,
} from "@werft-ai/contracts";
import type { Principal } from "../index.ts";

export type AgentIdentityRecord = {
  id: string;
  workspaceId: string;
  agentId: string;
  provider: AgentIdentityProvider;
  installationId: string;
  appId: string;
  teamId: string;
  externalPrincipalId: string;
  credentialRef: string;
  status: AgentIdentityStatus;
  revision: number;
  createdBy: string | null;
  createdAt: Date;
  revokedAt: Date | null;
};

export type LinkAgentIdentityResult =
  | { outcome: "linked"; identity: AgentIdentityRecord; receiptId: string }
  | { outcome: "agent_not_found" }
  // No verified install of that app in that team for this workspace.
  | { outcome: "not_installed" }
  // The install already belongs to another agent.
  | { outcome: "taken" }
  // This agent already holds the install.
  | { outcome: "exists"; identity: AgentIdentityRecord }
  // The bot token's name is bound to an agent or another identity.
  | { outcome: "credential_ref_in_use" }
  // The caller is no longer a member, or no longer holds the right.
  | { outcome: "actor_inactive" }
  | { outcome: "outranked" };

export type RevokeAgentIdentityResult =
  | { outcome: "revoked"; identity: AgentIdentityRecord; receiptId: string }
  | { outcome: "already_revoked"; identity: AgentIdentityRecord }
  | { outcome: "not_found" }
  | { outcome: "actor_inactive" }
  | { outcome: "outranked" };

/**
 * The agent a Slack event's app and team resolve to now. Only `resolved`
 * moves an agent; a drop names why, so the channel can log it.
 */
export type SlackEventAgent =
  | {
      status: "resolved";
      workspaceId: string;
      agentId: string;
      identity: { id: string; revision: number };
      installationId: string;
      botUserId: string;
      credentialRef: string;
      /** Other Slack bots whose direct mention the agent answers. */
      allowedBotUserIds: readonly string[];
      /**
       * The bot users of every Slack app this Werft install has in the
       * event's team, this one's among them. Agents do not talk over Slack.
       */
      werftBotUserIds: readonly string[];
    }
  | { status: "dropped"; reason: SlackEventDropReason };

export type SlackEventKey = { appId: string; teamId: string };

export interface AgentIdentityStore {
  /**
   * Pins the agent to the verified install of `appId` in `teamId`, under the
   * install's row lock so two links cannot both win it. Re-reads the
   * caller's membership and right (`managerRoles`, or admin of that agent)
   * in the same transaction. Writes a `link_agent_identity` receipt.
   */
  link(input: {
    principal: Principal;
    workspaceId: string;
    agentId: string;
    key: SlackEventKey;
    credentialRef: string;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<LinkAgentIdentityResult>;
  /** Revokes the identity and writes a `revoke_agent_identity` receipt. */
  revoke(input: {
    principal: Principal;
    workspaceId: string;
    agentId: string;
    identityId: string;
    managerRoles: readonly WorkspaceRole[];
  }): Promise<RevokeAgentIdentityResult>;
  /** The agent's identities, active first, newest first within each. */
  list(
    workspaceId: string,
    agentId: string,
    limit: number,
  ): Promise<AgentIdentityRecord[]>;
  /** Read for every event at processing time; never cached. */
  resolveSlackEvent(key: SlackEventKey): Promise<SlackEventAgent>;
}
