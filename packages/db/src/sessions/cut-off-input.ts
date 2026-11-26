import { sourceSetOf, WORKER_OWNERSHIP_LOST_REASON } from "@werft-ai/platform";
import { and, eq } from "drizzle-orm";
import { followUpFact } from "../action/push-follow-ups.ts";
import { lockedDeletedSource } from "../conversations/deleted-sources.ts";
import { inputTexts } from "../conversations/input-texts.ts";
import type { Database } from "../queries.ts";
import { type PrependSkipReason, turns } from "../schema.ts";

/** The line before a cut-off turn's input, in the turn after it. */
export const CUT_OFF_INPUT_LINE =
  "The request before this one was cut off midway. It was:";

type TurnInputRow = Pick<typeof turns.$inferSelect, "message" | "sources">;
type DeliveredTurn = Pick<
  typeof turns.$inferSelect,
  "id" | "sessionId" | "sequence" | "prependedTurn" | "prependSkipReason"
> &
  TurnInputRow;

/**
 * A turn's input as the engine is given it, read where the turn keeps it:
 * today the turn row's text. Null when the web input it came from can no
 * longer be read where that input is kept.
 */
export async function turnInputText(
  tx: Database,
  turn: TurnInputRow,
): Promise<string | null> {
  const web = sourceSetOf(turn.sources).direct.flatMap((key) =>
    key.slack === null && key.inputId !== null ? [key.inputId] : [],
  );
  if (web.length > 0) {
    const texts = await inputTexts(tx, web);
    if (web.some((id) => !texts.has(id))) return null;
  }
  // Turns queued before the follow-up wording became facts still hold the
  // old text; only a message equal to it is rewritten.
  return followUpFact(turn.message);
}

/**
 * The input handed to the worker for a turn: its own, with the input of the
 * cut-off turn right before it (worker_ownership_lost) put first. That input
 * came after the last checkpoint the turn starts from, so the engine would
 * not have it otherwise. The first delivery records what it decided on the
 * turn; a redelivery reads the record and never adds it twice.
 */
export async function deliveredTurnInput(
  tx: Database,
  input: {
    turn: DeliveredTurn;
    workspaceId: string | null;
    redelivery: boolean;
  },
): Promise<string> {
  const own =
    (await turnInputText(tx, input.turn)) ?? followUpFact(input.turn.message);
  const cutOff = await cutOffInput(tx, input);
  return cutOff === null ? own : `${CUT_OFF_INPUT_LINE}\n\n${cutOff}\n\n${own}`;
}

async function cutOffInput(
  tx: Database,
  input: {
    turn: DeliveredTurn;
    workspaceId: string | null;
    redelivery: boolean;
  },
): Promise<string | null> {
  const { turn } = input;
  if (turn.prependedTurn !== null) {
    if (turn.prependSkipReason !== null) return null;
    const [cut] = await tx
      .select({ message: turns.message, sources: turns.sources })
      .from(turns)
      .where(
        and(
          eq(turns.sessionId, turn.sessionId),
          eq(turns.sequence, turn.prependedTurn),
        ),
      );
    if (cut === undefined) return null;
    // Deleted since the first delivery: what was given then stays given,
    // but it is not given again.
    const read = await readCutOff(tx, cut, input.workspaceId);
    return "text" in read ? read.text : null;
  }
  // Nothing recorded on a redelivery: its first delivery found no cut-off
  // turn to put first, or ran on an image from before the record.
  if (input.redelivery) return null;
  const [cut] = await tx
    .select({
      sequence: turns.sequence,
      message: turns.message,
      sources: turns.sources,
    })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, turn.sessionId),
        eq(turns.sequence, turn.sequence - 1),
        eq(turns.status, "failed"),
        eq(turns.terminalReason, WORKER_OWNERSHIP_LOST_REASON),
      ),
    );
  if (cut === undefined) return null;
  const read = await readCutOff(tx, cut, input.workspaceId);
  await tx
    .update(turns)
    .set({
      prependedTurn: cut.sequence,
      prependSkipReason: "skip" in read ? read.skip : null,
    })
    .where(eq(turns.id, turn.id));
  return "text" in read ? read.text : null;
}

/**
 * The cut-off turn's input, unless a direct source of it was deleted (in
 * Slack, by an admin, or at a web input's Slack alias) or it cannot be read
 * where it is kept. The marks are locked as a turn's insert locks them, to
 * the end of the delivery: a delete under way is waited for and seen.
 */
async function readCutOff(
  tx: Database,
  cut: TurnInputRow,
  workspaceId: string | null,
): Promise<{ text: string } | { skip: PrependSkipReason }> {
  if (workspaceId !== null) {
    const stored = cut.sources as { direct?: unknown } | null;
    const deleted = await lockedDeletedSource(tx, {
      workspaceId,
      sessionId: null,
      sources: { direct: stored?.direct ?? [], inherited: [] },
      throughTurn: null,
    });
    if (deleted !== null) return { skip: "deleted_source" };
  }
  const text = await turnInputText(tx, cut);
  return text === null ? { skip: "unreadable_web_input" } : { text };
}
