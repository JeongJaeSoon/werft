import { DEFAULT_REPORT_MODE } from "@werft-ai/contracts";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { rowsOf } from "./statement-rows.ts";

// A `summary` link the start pass has not moved yet still reads NULL, true,
// true: it posts nothing until moved, as before the columns. The pass may run
// late or fail on a start, so every gate holds this, not the pass alone.
const unmovedSummary = (link: SQL) =>
  sql`(${link}.visibility = 'summary' AND ${link}.report_mode IS NULL)`;

// A link's own `report_mode` wins, else its binding's.
const reportModeOf = (link: SQL) => sql`coalesce(
  ${link}.report_mode,
  (SELECT pb.report_mode FROM surface_bindings pb WHERE pb.id = ${link}.surface_binding_id),
  ${DEFAULT_REPORT_MODE}
)`;

/**
 * Whether a link's thread hears of its turns: replies, failures and notices.
 * A link's own `report_mode` wins, else its binding's. Only `none` (a moved
 * `summary` link) is silent; until the modes post differently, every other
 * one posts once per turn, as `full` did.
 */
export const reportsTurns = (link: SQL) => sql`(
  NOT ${unmovedSummary(link)} AND ${reportModeOf(link)} <> 'none'
)`;

/** Whether a link's thread keeps a progress message (`report_mode` progress). */
export const reportsProgress = (link: SQL) => sql`(
  NOT ${unmovedSummary(link)} AND ${reportModeOf(link)} = 'progress'
)`;

/** Whether inputs asked from the web or the API show in the link's thread. */
export const mirrorsInstructions = (link: SQL) =>
  sql`(${link}.mirror_instructions AND NOT ${unmovedSummary(link)})`;

/** Whether approval cards and questions go to the link's thread. */
export const postsPrompts = (link: SQL) =>
  sql`(${link}.post_prompts AND NOT ${unmovedSummary(link)})`;

const MOVE_BATCH = 500;

/**
 * Moves every `summary` link to the columns that say the same: no turns, no
 * mirrored inputs, no cards. A `full` link needs nothing, the columns'
 * defaults being what it meant. Run at each host start, in batches, since
 * session_links only grows: a moved link is not found again (its
 * `report_mode` is set), and no writer makes a `summary` link.
 */
export async function moveSummaryLinks(db: Database): Promise<number> {
  let moved = 0;
  for (;;) {
    const rows = rowsOf<{ id: string }>(
      await db.execute(sql`
        UPDATE session_links SET report_mode = 'none',
          mirror_instructions = false, post_prompts = false
        WHERE id IN (
          SELECT id FROM session_links
          WHERE visibility = 'summary' AND report_mode IS NULL
          LIMIT ${MOVE_BATCH}
          -- Waits for a link another writer holds rather than skipping it,
          -- so a short batch means none is left.
          FOR UPDATE
        )
        AND visibility = 'summary' AND report_mode IS NULL
        RETURNING id
      `),
    );
    moved += rows.length;
    if (rows.length < MOVE_BATCH) return moved;
  }
}
