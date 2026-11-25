/**
 * The key of a refusal's Slack row: the one a failed turn's notice carries
 * (chat-slack's `slackTurnDedupeKey("failed", …)`). The row answers its
 * turn, so the failed turn's "try again shortly" is not sent beside it and
 * the thread's answered mark moves past the turn.
 */
export function budgetRefusalTurnDedupeKey(
  sessionLinkId: string,
  turnId: number,
): string {
  return `failure:${sessionLinkId}:${turnId}`;
}
