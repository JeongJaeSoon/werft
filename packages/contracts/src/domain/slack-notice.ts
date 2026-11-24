import { z } from "zod";

import { INT4_MAX } from "../shared/index.ts";

export const slackNoticeApprovalIdSchema = z
  .uuid()
  .brand<"SlackNoticeApprovalId">();
export type SlackNoticeApprovalId = z.infer<typeof slackNoticeApprovalIdSchema>;
export const slackNoticeVersionSchema = z
  .number()
  .int()
  .min(1)
  .max(INT4_MAX)
  .brand<"SlackNoticeVersion">();
export type SlackNoticeVersion = z.infer<typeof slackNoticeVersionSchema>;

/**
 * One version of the notice a workspace owner or admin approves for an
 * agent's Slack app before the agent listens there.
 */
export type SlackNoticeVersionEntry = {
  readonly version: SlackNoticeVersion;
  /**
   * False for a version that only rewords the one before: approvals of the
   * earlier versions still count.
   */
  readonly requiresReapproval: boolean;
};

/**
 * Oldest first, versions increasing. Publishing a version is adding an entry
 * here. Empty until the first notice is written, so no agent is approved.
 */
export const SLACK_NOTICE_VERSIONS: readonly SlackNoticeVersionEntry[] = [];

/** The versions an approval must fall within to count. */
export type SlackNoticeWindow = {
  readonly current: SlackNoticeVersion;
  /** The latest version that asked for a new approval, or the first one. */
  readonly oldestCounted: SlackNoticeVersion;
};

/** Null when there is no notice yet. Throws on a list whose versions do not increase. */
export function slackNoticeWindow(
  versions: readonly SlackNoticeVersionEntry[],
): SlackNoticeWindow | null {
  const [first] = versions;
  if (first === undefined) return null;
  let current = first.version;
  let oldestCounted = first.version;
  for (const entry of versions.slice(1)) {
    if (entry.version <= current) {
      throw new Error("Slack notice versions must increase");
    }
    current = entry.version;
    if (entry.requiresReapproval) oldestCounted = entry.version;
  }
  return { current, oldestCounted };
}
