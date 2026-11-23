import { type SQL, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { rowsOf } from "./statement-rows.ts";

/**
 * Whether a link's thread hears of its turns: replies, failures and notices.
 * A link's own `report_mode` wins, else its binding's. Only `none` (a moved
 * `summary` link) is silent; until the modes post differently, every other
 * one posts once per turn, as `full` did.
 */
export const reportsTurns = (link: SQL) => sql`(
  coalesce(
    ${link}.report_mode,
    (SELECT pb.report_mode FROM surface_bindings pb WHERE pb.id = ${link}.surface_binding_id)
  ) <> 'none'
)`;

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
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id
      `),
    );
    moved += rows.length;
    if (rows.length < MOVE_BATCH) return moved;
  }
}
