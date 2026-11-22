import {
  type BotTurnState,
  type BotTurnStore,
  type ChatThreadKey,
  claimBotTurn,
  releaseBotTurn,
  resetBotTurns,
} from "@werft-ai/platform";
import { and, eq } from "drizzle-orm";
import { DB_NOW } from "../db-clock.ts";
import type { Database } from "../queries.ts";
import { slackThreadBotTurns } from "../schema.ts";

const keyOf = (key: ChatThreadKey) =>
  and(
    eq(slackThreadBotTurns.workspaceId, key.workspaceId),
    eq(slackThreadBotTurns.teamId, key.teamId),
    eq(slackThreadBotTurns.channelId, key.channelId),
    eq(slackThreadBotTurns.threadTs, key.threadTs),
  );

export function createPostgresSlackThreadBotTurnStore(
  db: Database,
): BotTurnStore {
  /**
   * Applies `change` to the thread's row under its lock, so the agents of
   * one thread and a person's message there take turns. A person's message
   * makes the row too: a bot message it follows may still be on its way.
   */
  function locked<T>(
    key: ChatThreadKey,
    change: (state: BotTurnState) => { next: BotTurnState; result: T },
  ): Promise<T> {
    return db.transaction(async (tx) => {
      await tx
        .insert(slackThreadBotTurns)
        .values({ ...key })
        .onConflictDoNothing();
      const [row] = await tx
        .select({
          counted: slackThreadBotTurns.countedTurns,
          humanTs: slackThreadBotTurns.humanTs,
          stop: slackThreadBotTurns.stopTurn,
        })
        .from(slackThreadBotTurns)
        .where(keyOf(key))
        .for("update");
      if (!row) throw new Error("Slack thread bot-turn row is missing");
      const { next, result } = change(row);
      if (next !== row) {
        await tx
          .update(slackThreadBotTurns)
          .set({
            countedTurns: [...next.counted],
            humanTs: next.humanTs,
            stopTurn: next.stop,
            updatedAt: DB_NOW,
          })
          .where(keyOf(key));
      }
      return result;
    });
  }

  return {
    claim: (key, turn, limit) =>
      locked(key, (state) => {
        const { next, claim } = claimBotTurn(state, turn, limit);
        return { next, result: claim };
      }),
    release: (key, turn) =>
      locked(key, (state) => ({
        next: releaseBotTurn(state, turn),
        result: undefined,
      })),
    reset: (key, messageTs) =>
      locked(key, (state) => ({
        next: resetBotTurns(state, messageTs),
        result: undefined,
      })),
  };
}
