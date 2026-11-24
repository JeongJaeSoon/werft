import type {
  ConversationInputId,
  ConversationTurnId,
} from "@werft-ai/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

/**
 * Reads inputs' text again from where it points: a web input's from its turn
 * row (or, until the start pass moves it, its own), a buffered message's from
 * its row. The one place a reader of an input's text goes through; one it
 * cannot read is not in the map.
 */
export async function inputTexts(
  tx: Database,
  inputIds: readonly ConversationInputId[],
): Promise<Map<ConversationInputId, string>> {
  if (inputIds.length === 0) return new Map();
  const rows = rowsOf<{ id: ConversationInputId; body: string | null }>(
    await tx.execute(sql`
      SELECT i.id, COALESCE(ct.input_text, i.body) AS body
      FROM conversation_inputs i
      LEFT JOIN conversation_turns ct ON ct.id = i.conversation_turn_id
      WHERE i.id = ANY(${`{${inputIds.join(",")}}`}::uuid[])`),
  );
  return new Map(
    rows.flatMap((row) => (row.body === null ? [] : [[row.id, row.body]])),
  );
}

/**
 * Reads conversation turns' answers again from where they point: today the
 * turn row itself. The one place a reader of an answer's text goes through;
 * a turn with none, or gone, is not in the map.
 */
export async function turnAnswerTexts(
  tx: Database,
  turnIds: readonly ConversationTurnId[],
): Promise<Map<ConversationTurnId, string>> {
  if (turnIds.length === 0) return new Map();
  const rows = rowsOf<{ id: ConversationTurnId; answer: string | null }>(
    await tx.execute(sql`
      SELECT id, answer_text AS answer FROM conversation_turns
      WHERE id = ANY(${`{${turnIds.join(",")}}`}::uuid[])`),
  );
  return new Map(
    rows.flatMap((row) => (row.answer === null ? [] : [[row.id, row.answer]])),
  );
}
