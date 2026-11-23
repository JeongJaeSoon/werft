/**
 * An install link's state as the server keeps it: only the hash of the
 * value, and who may complete it for which agent's app.
 */
export type SurfaceInstallState = {
  workspaceId: string;
  agentId: string;
  slackAppId: string;
  actorUserId: string;
  /** The Slack team the workspace's config token belongs to. */
  teamId: string;
  redirectUrl: string;
  expiresAt: Date;
};

export type RecordSurfaceInstallResult =
  | { outcome: "verified"; installationId: string }
  | { outcome: "workspace_conflict" }
  /** Revoked while being registered; a new install reopens it. */
  | { outcome: "revoked" };

export interface SurfaceInstallStore {
  /** Stores a new state and drops states that expired before `now`. */
  issueState(
    stateHash: Uint8Array,
    state: SurfaceInstallState,
    now: Date,
  ): Promise<void>;
  /** Removes the state and returns it, so it is spent whatever comes next. */
  consumeState(stateHash: Uint8Array): Promise<SurfaceInstallState | null>;
  /**
   * Registers the app's install in the team for the workspace and marks it
   * verified with the bot user Slack reported for the token.
   */
  recordInstallation(input: {
    workspaceId: string;
    appId: string;
    teamId: string;
    botUserId: string;
  }): Promise<RecordSurfaceInstallResult>;
  /**
   * Marks the app's install in the team `revoked`, as Slack reported it
   * uninstalled or its bot token revoked. Revoking again keeps the first
   * time; `not_found` when the app was never installed there. With
   * `sentAt`, an install verified after it is left alone (`superseded`):
   * Slack retries a report for up to hours, past a reinstall.
   */
  revokeInstallation(
    key: { appId: string; teamId: string },
    sentAt?: Date | null,
  ): Promise<"revoked" | "not_found" | "superseded">;
}
