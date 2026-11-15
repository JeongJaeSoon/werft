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
