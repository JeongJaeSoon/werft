import type { Principal } from "../policy.ts";

export interface WebFetchPreflightSettingStore {
  /**
   * Saves the setting with its `set_web_fetch_preflight` receipt and returns
   * the receipt's id. Null when the workspace does not exist or
   * `actorUserId` is no longer an active owner or admin of it when the write
   * commits.
   */
  setWebFetchPreflight(input: {
    workspaceId: string;
    actorUserId: string;
    principal: Principal;
    enabled: boolean;
  }): Promise<string | null>;
}

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
