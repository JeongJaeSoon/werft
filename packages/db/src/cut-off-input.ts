import {
  CUT_OFF_TURN_REASONS,
  isCutOffTurnReason,
  stoppedBackgroundCommands,
  TURN_EMERGENCY_STOPPED_REASON,
} from "@werft-ai/contracts";
import { sourceSetOf } from "@werft-ai/platform";
import { and, desc, eq, isNotNull, lt, ne, sql } from "drizzle-orm";
import { followUpFact } from "./action/push-follow-ups.ts";
import { lockedDeletedSource } from "./conversations/deleted-sources.ts";
import { inputTexts } from "./conversations/input-texts.ts";
import type { Database } from "./queries.ts";
import { events, type PrependSkipReason, turns } from "./schema.ts";

/** The line before a cut-off turn's input, in the turn after it. */
export const CUT_OFF_INPUT_LINE =
  "The request before this one was cut off midway. It was:";

/**
 * The line a turn's input starts with when the idle worker before it stopped
 * the background work the session had left running. Command names only.
 */
export function stoppedBackgroundLine(commands: readonly string[]): string {
  const named = commands.length === 0 ? "" : `: ${commands.join(", ")}`;
  return `While this session was idle, the background work it had left running was stopped${named}. Start it again if it is still needed.`;
}

// How far back from the newest event of the notice's attempt it is looked
// for. Only what the engine says while the exiting worker waits for it to
// settle follows the notice, and that wait is a minute at most.
const STOPPED_BACKGROUND_LOOKBACK = 2_000;

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
 * cut-off turn right before it (worker_ownership_lost) put first. A turn an
 * emergency stop cut off is never put first: what goes on from it is a
 * person's continuation, so the skip is recorded instead. That input
 * came after the last checkpoint the turn starts from, so the engine would
 * not have it otherwise. The first delivery's decision is recorded on the
 * turn (recordCutOff); a redelivery reads the record and never adds it
 * twice.
 */
export async function deliveredTurnInput(
  tx: Database,
  input: {
    turn: DeliveredTurn;
    workspaceId: string | null;
    redelivery: boolean;
  },
): Promise<DeliveredInput> {
  const own =
    (await turnInputText(tx, input.turn)) ?? followUpFact(input.turn.message);
  const { text, record } = await cutOffInput(tx, input);
  const stopped = await stoppedBackground(tx, input.turn);
  const message =
    text === null ? own : `${CUT_OFF_INPUT_LINE}\n\n${text}\n\n${own}`;
  return {
    message:
      stopped === null
        ? message
        : `${stoppedBackgroundLine(stopped)}\n\n${message}`,
    record,
  };
}

/**
 * The commands an idle worker stopped after the last turn before this one
 * that was neither cut off nor cancelled, or null: the engine restored for
 * this turn would otherwise go on as if they were still running. Read from
 * the stored notice, so every delivery of the turn says the same.
 */
async function stoppedBackground(
  tx: Database,
  turn: DeliveredTurn,
): Promise<string[] | null> {
  const [before] = await tx
    .select({ id: turns.id, attemptId: turns.attemptId })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, turn.sessionId),
        lt(turns.sequence, turn.sequence),
        isNotNull(turns.deliveryStartedAt),
        // One an operator abandoned after it was delivered.
        ne(turns.status, "cancelled"),
        sql`coalesce(${turns.terminalReason}, '') NOT IN (${sql.join(
          CUT_OFF_TURN_REASONS.map((reason) => sql`${reason}`),
          sql`, `,
        )})`,
      ),
    )
    .orderBy(desc(turns.sequence))
    .limit(1);
  if (before === undefined || before.attemptId === null) return null;
  // By the attempt that ran the turn, whose events the index holds apart:
  // what later turns wrote is neither read nor in the way.
  const recent = tx
    .select({
      type: events.type,
      payload: events.payload,
      turnId: events.turnId,
      sequence: events.sourceSequence,
    })
    .from(events)
    .where(
      and(
        eq(events.sessionId, turn.sessionId),
        eq(events.attemptId, before.attemptId),
        isNotNull(events.sourceSequence),
      ),
    )
    .orderBy(desc(events.sourceSequence))
    .limit(STOPPED_BACKGROUND_LOOKBACK)
    .as("recent");
  const [notice] = await tx
    .select({ payload: recent.payload })
    .from(recent)
    .where(
      and(
        eq(recent.type, "system"),
        eq(recent.turnId, before.id),
        sql`${recent.payload}->>'subtype' = 'background_tasks_stopped'`,
      ),
    )
    .orderBy(desc(recent.sequence))
    .limit(1);
  return notice === undefined
    ? null
    : stoppedBackgroundCommands(notice.payload);
}

/**
 * What a first delivery decided, for the caller to write with the rest of
 * the hand-over: only once the lease is judged again after the source mark
 * locks the decision may have waited on.
 */
export type CutOffRecord = {
  prependedTurn: number;
  prependSkipReason: PrependSkipReason | null;
};
export type DeliveredInput = { message: string; record: CutOffRecord | null };

export async function recordCutOff(
  tx: Database,
  turnRowId: number,
  record: CutOffRecord | null,
): Promise<void> {
  if (record === null) return;
  await tx.update(turns).set(record).where(eq(turns.id, turnRowId));
}

async function cutOffInput(
  tx: Database,
  input: {
    turn: DeliveredTurn;
    workspaceId: string | null;
    redelivery: boolean;
  },
): Promise<{ text: string | null; record: CutOffRecord | null }> {
  const none = { text: null, record: null };
  const { turn } = input;
  if (turn.prependedTurn !== null) {
    if (turn.prependSkipReason !== null) return none;
    const [cut] = await tx
      .select({ message: turns.message, sources: turns.sources })
      .from(turns)
      .where(
        and(
          eq(turns.sessionId, turn.sessionId),
          eq(turns.sequence, turn.prependedTurn),
        ),
      );
    if (cut === undefined) return none;
    // Deleted since the first delivery: what was given then stays given,
    // but it is not given again.
    const read = await readCutOff(tx, cut, input.workspaceId);
    return { text: "text" in read ? read.text : null, record: null };
  }
  // Nothing recorded on a redelivery: its first delivery found no cut-off
  // turn to put first, or ran on an image from before the record.
  if (input.redelivery) return none;
  const [cut] = await tx
    .select({
      sequence: turns.sequence,
      message: turns.message,
      sources: turns.sources,
      terminalReason: turns.terminalReason,
      status: turns.status,
    })
    .from(turns)
    .where(
      and(
        eq(turns.sessionId, turn.sessionId),
        lt(turns.sequence, turn.sequence),
        // One cancelled before it ran (an emergency stop's) is passed over.
        ne(turns.status, "cancelled"),
      ),
    )
    .orderBy(desc(turns.sequence))
    .limit(1);
  if (
    cut === undefined ||
    cut.status !== "failed" ||
    !isCutOffTurnReason(cut.terminalReason)
  ) {
    return none;
  }
  if (cut.terminalReason === TURN_EMERGENCY_STOPPED_REASON) {
    return {
      text: null,
      record: {
        prependedTurn: cut.sequence,
        prependSkipReason: TURN_EMERGENCY_STOPPED_REASON,
      },
    };
  }
  const read = await readCutOff(tx, cut, input.workspaceId);
  return {
    text: "text" in read ? read.text : null,
    record: {
      prependedTurn: cut.sequence,
      prependSkipReason: "skip" in read ? read.skip : null,
    },
  };
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
