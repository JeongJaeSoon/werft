/** The one reaction the agent puts on a message: 👀, "I will answer this". */
export const SLACK_REACTION_NAME = "eyes";

/**
 * The bot scope `reactions.add` needs. An install from before it lacks it
 * until an admin approves the app again; until then no reaction is sent
 * (`slackAppGrants`), and a row that still goes ends `missing_scope`.
 */
export const SLACK_REACTION_SCOPE = "reactions:write";

/**
 * One reaction per message: a Slack team's channel and the message's ts,
 * whichever agent, installation or session asked for it.
 */
export function slackReactionDedupeKey(target: {
  teamId: string;
  channelId: string;
  ts: string;
}): string {
  return `reaction:${target.teamId}:${target.channelId}:${target.ts}`;
}
