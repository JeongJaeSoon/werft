import { randomUUID } from "node:crypto";
import {
  type ConversationId,
  type ConversationInputId,
  type ConversationJudgmentId,
  type ConversationTopicId,
  M1_PROMPT_VERSION,
  type SlackNoticeVersionEntry,
} from "@werft-ai/contracts";
import {
  type ClaimedReplyJudgment,
  JUDGMENT_BATCH_DEADLINE_MS,
  M1_CHANNEL_WINDOW_MS,
  type M1JudgmentStore,
  type M1Place,
  type M1Record,
  storedSourceSet,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import {
  dropBufferedInputs,
  engagedJudgmentsInWindow,
  JUDGMENT_BUFFER_TTL_MS,
  m1ChannelCap,
} from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { conversationGate } from "./slack-notice-approvals.ts";

type GateVersions = readonly SlackNoticeVersionEntry[] | undefined;

const secs = (ms: number) => sql`make_interval(secs => ${ms / 1000})`;

/**
 * The gate a judgment passes before its call and again before its record:
 * the switch raised, the notice approved, and the channel not shared with
 * another organization. With `lock`, in the writing transaction, a revoke
 * or a lowering waits for the write or is seen by it.
 */
async function gateOpenIn(
  db: Database,
  place: M1Place,
  lock: boolean,
  versions: GateVersions,
): Promise<boolean> {
  const gate = await conversationGate(db, place, {
    lock,
    ...(versions === undefined ? {} : { versions }),
  });
  if (!gate.open) return false;
  // Locked, a share recorded meanwhile waits for the write, whose rows its
  // buffer drop then finds.
  const bindings = rowsOf<{ external_shared: boolean }>(
    await db.execute(sql`
      SELECT external_shared FROM surface_bindings
      WHERE agent_id = ${place.agentId}::uuid AND surface = 'slack'
        AND external_surface_id = ${place.channelId}
      ${lock ? sql`FOR SHARE` : sql``}`),
  );
  return !bindings.some((binding) => binding.external_shared);
}

/**
 * The gate a reply's waiting judgment is written under, in the transaction
 * that receives it: closed, the reply asks for no judgment.
 */
export function m1GateOpenForWrite(
  tx: Database,
  place: M1Place,
): Promise<boolean> {
  return gateOpenIn(tx, place, true, undefined);
}

/** A record's verdict and what it read, as its columns hold them. */
function verdictColumns(record: M1Record) {
  const sources = storedSourceSet({
    direct: record.sources.keys,
    inherited: [],
    overflow: record.sources.overflow,
  });
  return {
    sources: sources === null ? null : JSON.stringify(sources),
    outcome: record.verdict.outcome,
    decision: record.verdict.decision,
    reason: record.verdict.reason,
  };
}

const textArray = (values: readonly string[]): SQL =>
  sql`ARRAY[${sql.join(
    values.map((value) => sql`${value}`),
    sql`, `,
  )}]::text[]`;

type WaitingRow = {
  id: ConversationJudgmentId;
  workspace_id: string;
  agent_id: string;
  conversation_id: ConversationId;
  grade: "m1" | "m1_to_task" | "m1_engaged";
  slack_team_id: string;
  slack_channel_id: string;
  input_id: ConversationInputId | null;
  refs: string[];
};

// Lock order, as the switch's lowering and an admin's delete take theirs:
// the agent (the gate), then buffered inputs, then judgment rows.

/** Drops a waiting reply's row, its held text first when it has one. */
async function dropReply(
  tx: Database,
  row: Pick<WaitingRow, "id" | "grade" | "input_id">,
) {
  if (row.grade === "m1_engaged" && row.input_id !== null) {
    await dropBufferedInputs(tx, [row.input_id]);
  }
  await tx.execute(sql`
    DELETE FROM conversation_judgments
    WHERE id = ${row.id}::uuid AND outcome IS NULL`);
}

/**
 * Takes the lock the channel's batches are closed under, so a batch and a
 * reply never both count the window's last place.
 */
async function lockChannelWindow(
  tx: Database,
  row: Pick<WaitingRow, "agent_id" | "slack_team_id" | "slack_channel_id">,
) {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('judgment_batch'), hashtext(${`${row.agent_id}:${row.slack_team_id}:${row.slack_channel_id}`}::text))`,
  );
}

/** Whether the channel's judgments at `at` have reached M1's cap. */
async function atCap(
  db: Database,
  row: Pick<WaitingRow, "agent_id" | "slack_team_id" | "slack_channel_id">,
  at: SQL,
): Promise<boolean> {
  const [window] = rowsOf<{ full: boolean }>(
    await db.execute(sql`
      SELECT ((SELECT count(*) FROM judgment_batches b
        WHERE b.agent_id = ${row.agent_id}::uuid
          AND b.slack_team_id = ${row.slack_team_id}
          AND b.slack_channel_id = ${row.slack_channel_id}
          AND b.closed_at > ${at} - ${secs(M1_CHANNEL_WINDOW_MS)}
          AND (b.state = 'judging' OR (b.state IN ('judged', 'failed') AND b.model_called IS NOT FALSE)))
        + ${engagedJudgmentsInWindow({
          agentId: sql`${row.agent_id}::uuid`,
          teamId: sql`${row.slack_team_id}`,
          channelId: sql`${row.slack_channel_id}`,
          at,
        })}) >= ${m1ChannelCap({
          agentId: sql`${row.agent_id}::uuid`,
          channelId: sql`${row.slack_channel_id}`,
        })} AS full`),
  );
  return window?.full ?? false;
}

/**
 * M1's judgment records over PostgreSQL. A record holds Slack ts, codes and
 * ids; a held reply's text goes once it is judged or given up.
 */
export function createPostgresM1JudgmentStore(
  db: Database,
  options: { versions?: GateVersions } = {},
): M1JudgmentStore {
  const { versions } = options;
  return {
    gateOpen: (place) => gateOpenIn(db, place, false, versions),

    async recordBatch(batch, record, judged) {
      return db.transaction(async (tx) => {
        if (!(await gateOpenIn(tx, batch, true, versions))) return false;
        const columns = verdictColumns(record);
        await tx.execute(sql`
          INSERT INTO conversation_judgments (
            id, workspace_id, agent_id, conversation_id, grade,
            slack_team_id, slack_channel_id, refs, sources,
            judgment_batch_id, release_id, call_key, attempts,
            prompt_version, outcome, decision, reason, judged_at
          ) VALUES (
            ${randomUUID()}::uuid, ${batch.workspaceId}::uuid,
            ${batch.agentId}::uuid, ${batch.conversationId}::uuid,
            'buffer_m1', ${batch.teamId}, ${batch.channelId},
            ${textArray(record.refs)}, ${columns.sources}::jsonb,
            ${batch.id}::uuid, ${record.releaseId}, ${record.callKey},
            ${record.attempts}, ${M1_PROMPT_VERSION}, ${columns.outcome},
            ${columns.decision}, ${columns.reason}, now()
          )`);
        await dropBufferedInputs(tx, judged);
        return true;
      });
    },

    async claimReply(options = {}) {
      const at =
        options.now === undefined
          ? sql`now()`
          : sql`${options.now.toISOString()}::timestamptz`;
      // Unjudged past the buffer's time, or taken by a judge that died:
      // given up, as a buffered message expires unjudged.
      const lapsed = rowsOf<Pick<WaitingRow, "id" | "grade" | "input_id">>(
        await db.execute(sql`
          SELECT id, grade, input_id FROM conversation_judgments
          WHERE outcome IS NULL
            AND (created_at <= ${at} - ${secs(JUDGMENT_BUFFER_TTL_MS)}
              OR claimed_at <= ${at} - ${secs(JUDGMENT_BATCH_DEADLINE_MS)})
          ORDER BY created_at
          LIMIT 100`),
      );
      for (const row of lapsed) {
        await db.transaction((tx) => dropReply(tx, row));
      }
      for (;;) {
        // Taken and, for `m1_engaged`, held to the cap in one transaction:
        // claims of one channel count each other one at a time.
        const taken = await db.transaction(async (tx) => {
          const [row] = rowsOf<WaitingRow>(
            await tx.execute(sql`
              SELECT id, workspace_id, agent_id, conversation_id, grade,
                slack_team_id, slack_channel_id, input_id, refs
              FROM conversation_judgments
              WHERE outcome IS NULL AND claimed_at IS NULL
                AND created_at > ${at} - ${secs(JUDGMENT_BUFFER_TTL_MS)}
              ORDER BY created_at
              LIMIT 1
              FOR UPDATE SKIP LOCKED`),
          );
          if (row === undefined) return null;
          let rateLimited = false;
          if (row.grade === "m1_engaged") {
            await lockChannelWindow(tx, row);
            rateLimited = await atCap(tx, row, at);
          }
          await tx.execute(sql`
            UPDATE conversation_judgments SET claimed_at = ${at}
            WHERE id = ${row.id}::uuid`);
          return { row, rateLimited };
        });
        if (taken === null) return null;
        const { row, rateLimited } = taken;
        const inputId = row.input_id;
        const ts = row.refs[0];
        const [post] =
          inputId === null
            ? []
            : rowsOf<{
                topic_id: ConversationTopicId;
                received_at: Date | string;
                body: string | null;
              }>(
                await db.execute(sql`
                  SELECT i.topic_id, i.received_at,
                    COALESCE(i.body, t.message) AS body
                  FROM conversation_inputs i
                  LEFT JOIN turns t ON t.id = i.turn_id
                  WHERE i.id = ${inputId}::uuid`),
              );
        if (
          inputId === null ||
          ts === undefined ||
          post === undefined ||
          post.body === null
        ) {
          // Its input went (a delete, an admin's): nothing left to judge.
          await db.transaction((tx) => dropReply(tx, row));
          continue;
        }
        const claimed: ClaimedReplyJudgment = {
          id: row.id,
          rateLimited,
          subject: {
            grade: row.grade,
            workspaceId: row.workspace_id,
            agentId: row.agent_id,
            conversationId: row.conversation_id,
            teamId: row.slack_team_id,
            channelId: row.slack_channel_id,
            topicId: post.topic_id,
            key: inputId,
            posts: [
              {
                inputId,
                ts,
                body: post.body,
                receivedAt: new Date(post.received_at),
                sources: [
                  {
                    inputId,
                    slack: {
                      teamId: row.slack_team_id,
                      channelId: row.slack_channel_id,
                      ts,
                    },
                  },
                ],
              },
            ],
          },
        };
        return claimed;
      }
    },

    async finishReply(id, record) {
      const [row] = rowsOf<WaitingRow>(
        await db.execute(sql`
          SELECT id, workspace_id, agent_id, grade, slack_team_id,
            slack_channel_id, input_id
          FROM conversation_judgments
          WHERE id = ${id}::uuid AND outcome IS NULL`),
      );
      if (row === undefined) return "dropped";
      return db.transaction(async (tx) => {
        if (
          record === null ||
          !(await gateOpenIn(
            tx,
            {
              workspaceId: row.workspace_id,
              agentId: row.agent_id,
              teamId: row.slack_team_id,
              channelId: row.slack_channel_id,
            },
            true,
            versions,
          ))
        ) {
          await dropReply(tx, row);
          return "dropped";
        }
        if (row.grade === "m1_engaged" && row.input_id !== null) {
          await dropBufferedInputs(tx, [row.input_id]);
        }
        const columns = verdictColumns(record);
        const written = rowsOf(
          await tx.execute(sql`
            UPDATE conversation_judgments SET
              sources = ${columns.sources}::jsonb,
              release_id = ${record.releaseId}, call_key = ${record.callKey},
              attempts = ${record.attempts}, outcome = ${columns.outcome},
              decision = ${columns.decision}, reason = ${columns.reason},
              judged_at = now()
            WHERE id = ${id}::uuid AND outcome IS NULL
            RETURNING id`),
        );
        return written.length > 0 ? "written" : "dropped";
      });
    },
  };
}
