import { defaultReportMode } from "@werft-ai/contracts";
import { type SQL, sql } from "drizzle-orm";
import type { Database } from "./queries.ts";
import { rowsOf } from "./statement-rows.ts";

// A `summary` link the start pass has not moved yet still reads NULL, true,
// true: it posts nothing until moved, as before the columns. The pass may run
// late or fail on a start, so every gate holds this, not the pass alone.
const unmovedSummary = (link: SQL) =>
  sql`(${link}.visibility = 'summary' AND ${link}.report_mode IS NULL)`;

/**
 * The report mode a link's thread hears of its work by: the link's own, else
 * its channel's, else the default of its agent's conversation rollout
 * (`defaultReportMode`). A DM has no report mode to choose (v1-b/DM2): its
 * binding's value is never read. Read on every pass while the link is open:
 * a channel picking a mode, or an agent's rollout moving, changes the open
 * threads that pick none. A closing link keeps the mode it closed under
 * (`closingReportMode`).
 */
export const reportModeOf = (link: SQL) => sql`coalesce(
  ${link}.report_mode,
  (SELECT CASE WHEN pb.surface_kind = 'dm' THEN NULL ELSE pb.report_mode END
   FROM surface_bindings pb WHERE pb.id = ${link}.surface_binding_id),
  (SELECT CASE pa.conversation_rollout WHEN 'on' THEN ${defaultReportMode("on")}
     ELSE ${defaultReportMode("off")} END
   FROM agents pa WHERE pa.id = ${link}.agent_id),
  ${defaultReportMode("off")}
)`;

/**
 * The mode a link stores as it closes: the one it closed under, so a channel
 * or a rollout changed later never moves what a closed thread still takes
 * (its follow-ups, a day on). An unmoved `summary` link keeps its NULL.
 */
export const closingReportMode = (
  link: SQL,
) => sql`(CASE WHEN ${unmovedSummary(link)}
  THEN ${link}.report_mode ELSE ${reportModeOf(link)} END)`;

/**
 * Whether a link's thread hears of its turns: replies, failures and notices.
 * Its mode is `reportModeOf`. Only `none` (a moved
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

/**
 * Whether a link's thread hears only of its work's ends (`notify_only`,
 * `progress`): the reply once nothing is left to run, each failure, a
 * person needed. `per_step` hears of every turn.
 */
export const reportsWorkOnly = (link: SQL) => sql`(
  NOT ${unmovedSummary(link)}
  AND ${reportModeOf(link)} IN ('notify_only', 'progress')
)`;

/** Whether a link's thread is told once that its work started (`notify_only`). */
export const reportsStartOnly = (link: SQL) => sql`(
  NOT ${unmovedSummary(link)} AND ${reportModeOf(link)} = 'notify_only'
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
