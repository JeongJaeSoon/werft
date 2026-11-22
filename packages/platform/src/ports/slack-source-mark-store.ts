/**
 * A Slack message, as Slack names it inside one Werft workspace. Marks keep
 * only this and a time: never the message's text.
 */
export type SlackSourceMark = {
  workspaceId: string;
  teamId: string;
  channelId: string;
  ts: string;
  /** When Slack says the message was deleted or last edited. */
  at: Date;
};

/**
 * Marks of Slack messages someone deleted or edited. A delete wins: it drops
 * the message's edit mark, and an edit after it leaves no mark.
 */
export interface SlackSourceMarkStore {
  /** `duplicate` when the message already has its delete mark. */
  markDeleted(mark: SlackSourceMark): Promise<"recorded" | "duplicate">;
  /**
   * Keeps the latest edit time of the message; `deleted` when it has a
   * delete mark, which leaves it unchanged.
   */
  markEdited(mark: SlackSourceMark): Promise<"recorded" | "deleted">;
}
