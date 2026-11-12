import type { WorkspaceRole } from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/index.ts";

/** A credential name an agent may use; the value lives outside Werft. */
export type CredentialBinding = {
  id: string;
  agentId: string;
  credentialRef: string;
  boundBy: string;
  boundAt: Date;
  revokedAt: Date | null;
  /** Sessions on this agent's releases that name this credential and have not closed. */
  runningSessions: number;
};

export type BindCredentialResult =
  | { outcome: "bound" | "already_bound"; binding: CredentialBinding }
  | {
      outcome:
        | "actor_inactive"
        | "agent_not_found"
        | "outranked"
        /** An agent identity holds this name (M8). */
        | "ref_in_use";
    };

export type RevokeCredentialResult =
  | { outcome: "revoked"; binding: CredentialBinding }
  | { outcome: "not_found" | "actor_inactive" | "outranked" };

/** Someone a requester can ask to fix a binding. */
export type AgentContact = {
  userId: string;
  displayName: string;
  email: string;
};

export interface CredentialBindingStore {
  bind(input: {
    principal: Principal;
    id: string;
    workspaceId: string;
    agentId: string;
    credentialRef: string;
    boundBy: string;
    receiptId: string;
    /**
     * The roles that may bind, re-read under the binder's membership lock;
     * the agent's admins may as well.
     */
    binderRoles: readonly WorkspaceRole[];
  }): Promise<BindCredentialResult>;
  revoke(input: {
    principal: Principal;
    workspaceId: string;
    agentId: string;
    bindingId: string;
    receiptId: string;
    revokerRoles: readonly WorkspaceRole[];
  }): Promise<RevokeCredentialResult>;
  /** The agent's live bindings; null when the workspace has no such agent. */
  list(
    workspaceId: string,
    agentId: string,
  ): Promise<CredentialBinding[] | null>;
  /**
   * The names a release's card uses that have no live binding on its agent,
   * sorted; empty when every name is bound or the release names none.
   */
  unboundRefs(workspaceId: string, releaseId: string): Promise<string[]>;
  /**
   * Who to ask about an agent's bindings: its live admins, or, when it has
   * none left, the workspace's owners and admins.
   */
  contacts(workspaceId: string, agentId: string): Promise<AgentContact[]>;
}
