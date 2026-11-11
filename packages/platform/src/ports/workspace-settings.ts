import type { AgentAccessSettings } from "@werft-ai/contracts";
import type { Principal } from "../musterrolle/index.ts";

export interface SlackGuestSettingStore {
  /**
   * False when the workspace does not exist or `actorUserId` is no longer an
   * active owner or admin of it when the write commits.
   */
  setSlackGuestEnabled(input: {
    workspaceId: string;
    actorUserId: string;
    enabled: boolean;
  }): Promise<boolean>;
}

/**
 * `inactive`: the workspace is gone or `actorUserId` is no longer an active
 * owner or admin of it when the write commits. `unchanged` writes no receipt.
 */
export type SetAgentAccessResult =
  | { outcome: "set" | "unchanged"; settings: AgentAccessSettings }
  | { outcome: "inactive" };

export interface AgentAccessSettingStore {
  /** A key left out of `settings` keeps its value. */
  setAgentAccess(input: {
    principal: Principal;
    workspaceId: string;
    actorUserId: string;
    settings: {
      [K in keyof AgentAccessSettings]?: AgentAccessSettings[K] | undefined;
    };
    receiptId: string;
  }): Promise<SetAgentAccessResult>;
}
