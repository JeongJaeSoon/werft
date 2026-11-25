import { randomUUID } from "node:crypto";
import {
  type ConversationId,
  type ConversationInputId,
  type ConversationJudgmentId,
  type ConversationTopicId,
  type JudgmentVoidedReason,
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
  appendChannelSummaryLines,
  channelMarksSettledAt,
  dropBufferedInputs,
  engagedJudgmentsInWindow,
  JUDGMENT_BUFFER_TTL_MS,
  lockedReadChanges,
  m1ChannelCap,
  type ReadChanges,
  type ReadMessage,
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

/**
 * Check spot ② (a1/J6) for a record about to be written: a judged result
 * whose messages were deleted or edited while the model ran, or a context
 * message it read deleted, is voided. The marks of what it read are locked
 * to the end of `tx` either way, so call it before the gate, as a hold
 * takes a mark's lock before the agent's row. A called judgment that failed
 * is voided alike, so it keeps no deleted message's place; one never called
 * read nothing.
 */
async function voidedBy(
  tx: Database,
  place: Pick<M1Place, "workspaceId" | "teamId" | "channelId">,
  record: M1Record,
  messages: readonly ReadMessage[],
  /** When the call's input was read: the batch's close, the reply's claim. */
  readAt: SQL,
): Promise<{
  reason: JudgmentVoidedReason;
  changes: ReadChanges;
  /** Now, under the marks' locks: when a judgment again reads its input. */
  at: string;
} | null> {
  if (record.attempts === 0 || messages.length === 0) return null;
  const changes = await lockedReadChanges(tx, {
    ...place,
    messages,
    context: record.sources.keys,
    readAt,
    overflow: record.sources.overflow,
  });
  const reason: JudgmentVoidedReason | null =
    changes.deleted.length > 0 || changes.contextDeleted
      ? "voided_by_delete"
      : changes.edited.length > 0 || changes.contextEdited
        ? "voided_by_edit"
        : null;
  if (reason === null) return null;
  const [clock] = rowsOf<{ at: string }>(
    await tx.execute(sql`SELECT clock_timestamp()::text AS at`),
  );
  return { reason, changes, at: clock?.at ?? new Date().toISOString() };
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

/** A summary write that found the channel deleted, to roll it back. */
class ChannelGone extends Error {}

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

    async writeSummaryLine(batch, line) {
      try {
        return await db.transaction(async (tx) => {
          // Locks: the sources' marks, this agent's binding (the gate), the
          // summary's row, as a record takes the marks, then the gate, and a
          // channel delete its binding, then the summary's row. A delete of
          // any agent's, committed first, keeps the summary gone: its binding
          // is read with the row held, after that delete ends.
          const written = await appendChannelSummaryLines(tx, {
            gateOpen: () => gateOpenIn(tx, batch, true, versions),
            channelThere: async () =>
              rowsOf(
                await tx.execute(sql`
                SELECT 1 FROM surface_bindings b
                JOIN slack_installations i ON i.id = b.installation_id
                WHERE b.workspace_id = ${batch.workspaceId}::uuid
                  AND b.surface = 'slack' AND i.team_id = ${batch.teamId}
                  AND b.external_surface_id = ${batch.channelId}
                  AND b.revoked_at IS NULL AND b.status = 'gone'
                LIMIT 1`),
              ).length === 0,
            place: {
              workspaceId: batch.workspaceId,
              teamId: batch.teamId,
              channelId: batch.channelId,
            },
            expectedVersion: line.expectedVersion,
            agentId: batch.agentId,
            lines: [{ text: line.text, sources: line.sources }],
          });
          if (written.outcome === "channel_gone") throw new ChannelGone();
          return written;
        });
      } catch (error) {
        // Rolled back, the summary row it made goes too.
        if (error instanceof ChannelGone) {
          return { outcome: "channel_gone" as const };
        }
        throw error;
      }
    },

    async recordBatch(batch, record, judged, options = {}) {
      return db.transaction(async (tx) => {
        const voided = await voidedBy(
          tx,
          batch,
          record,
          judged.map((post) => ({
            ts: post.ts,
            editMark: post.editMark,
            buffered: { inputId: post.inputId, body: post.body },
          })),
          (options.readAt ?? batch.readAt) === undefined
            ? sql`(SELECT closed_at FROM judgment_batches WHERE id = ${batch.id}::uuid)`
            : sql`${options.readAt ?? batch.readAt}::timestamptz`,
        );
        if (!(await gateOpenIn(tx, batch, true, versions))) {
          return { outcome: "closed" };
        }
        if (voided !== null) {
          // The call's row, linked by its key; no decision, no place.
          await tx.execute(sql`
            INSERT INTO conversation_judgments (
              id, workspace_id, agent_id, conversation_id, grade,
              slack_team_id, slack_channel_id, refs, judgment_batch_id,
              release_id, call_key, attempts, prompt_version, outcome,
              reason, judged_at
            ) VALUES (
              ${randomUUID()}::uuid, ${batch.workspaceId}::uuid,
              ${batch.agentId}::uuid, ${batch.conversationId}::uuid,
              'buffer_m1', ${batch.teamId}, ${batch.channelId},
              '{}'::text[], ${batch.id}::uuid, ${record.releaseId},
              ${record.callKey}, ${record.attempts}, ${M1_PROMPT_VERSION},
              'voided', ${voided.reason}, now()
            )`);
          const left = new Set([
            ...voided.changes.deleted,
            ...voided.changes.gone,
          ]);
          const edited = new Map(
            voided.changes.edited.map((post) => [post.ts, post.body]),
          );
          // A post edited with no new text held cannot be read again.
          const remaining = judged
            .filter(
              (post) => !left.has(post.ts) && edited.get(post.ts) !== null,
            )
            .map((post) => ({
              ...post,
              body: edited.get(post.ts) ?? post.body,
              editMark: voided.changes.editMarks[post.ts] ?? null,
            }));
          if (options.final !== true) {
            return {
              outcome: "voided",
              reason: voided.reason,
              remaining,
              readAt: voided.at,
            };
          }
          // Judged once more and voided again: the batch's buffered rows go,
          // those the judgment again had no room for too, so no third call.
          const held = rowsOf<{ id: string }>(
            await tx.execute(sql`
              SELECT id FROM conversation_inputs
              WHERE judgment_batch_id = ${batch.id}::uuid
                AND buffer_expires_at IS NOT NULL`),
          );
          await dropBufferedInputs(
            tx,
            held.map((row) => row.id),
          );
          return {
            outcome: "voided",
            reason: voided.reason,
            remaining: [],
            readAt: voided.at,
          };
        }
        const columns = verdictColumns(record);
        await tx.execute(sql`
          INSERT INTO conversation_judgments (
            id, workspace_id, agent_id, conversation_id, grade,
            slack_team_id, slack_channel_id, refs, sources,
            judgment_batch_id, release_id, call_key, attempts,
            prompt_version, outcome, decision, reason, summary, judged_at
          ) VALUES (
            ${randomUUID()}::uuid, ${batch.workspaceId}::uuid,
            ${batch.agentId}::uuid, ${batch.conversationId}::uuid,
            'buffer_m1', ${batch.teamId}, ${batch.channelId},
            ${textArray(record.refs)}, ${columns.sources}::jsonb,
            ${batch.id}::uuid, ${record.releaseId}, ${record.callKey},
            ${record.attempts}, ${M1_PROMPT_VERSION}, ${columns.outcome},
            ${columns.decision}, ${columns.reason}, ${record.summary}, now()
          )`);
        await dropBufferedInputs(
          tx,
          judged.map((post) => post.inputId),
        );
        return { outcome: "written" };
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
                edit_mark: string | null;
              }>(
                await db.execute(sql`
                  SELECT i.topic_id, i.received_at,
                    COALESCE(i.body, t.message) AS body,
                    -- In one snapshot with the text, for the write's check.
                    (SELECT m.marked_at::text FROM edited_sources m
                      WHERE m.workspace_id = i.workspace_id
                        AND m.team_id = i.slack_team_id
                        AND m.channel_id = i.slack_channel_id
                        AND m.ts = i.slack_ts) AS edit_mark
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
          // Before the judgment reads its context (a1/J6).
          readAt: await channelMarksSettledAt(db, {
            workspaceId: row.workspace_id,
            teamId: row.slack_team_id,
            channelId: row.slack_channel_id,
          }),
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
                editMark: post.edit_mark,
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

    async finishReply(id, record, options = {}) {
      const [row] = rowsOf<WaitingRow>(
        await db.execute(sql`
          SELECT id, workspace_id, agent_id, grade, slack_team_id,
            slack_channel_id, input_id, refs
          FROM conversation_judgments
          WHERE id = ${id}::uuid AND outcome IS NULL`),
      );
      if (row === undefined) return "dropped";
      const place = {
        workspaceId: row.workspace_id,
        agentId: row.agent_id,
        teamId: row.slack_team_id,
        channelId: row.slack_channel_id,
      };
      return db.transaction(async (tx) => {
        const [ts] = row.refs;
        const { read } = options;
        // A held reply's text is in the buffer; a bound one's is kept
        // nowhere past its turn, so any edit mark changed it.
        const voided =
          record === null || ts === undefined
            ? null
            : await voidedBy(
                tx,
                place,
                record,
                [
                  {
                    ts,
                    editMark: read?.editMark ?? null,
                    buffered:
                      row.grade === "m1_engaged" && read !== undefined
                        ? { inputId: row.input_id, body: read.body }
                        : null,
                  },
                ],
                options.readAt === undefined
                  ? sql`(SELECT claimed_at FROM conversation_judgments WHERE id = ${id}::uuid)`
                  : sql`${options.readAt}::timestamptz`,
              );
        if (record === null || !(await gateOpenIn(tx, place, true, versions))) {
          await dropReply(tx, row);
          return "dropped";
        }
        if (voided !== null) {
          // A held reply still there is judged once more: on the buffer's
          // new text when it was edited, else on the text read when only
          // its context went. A bound reply's is not (Architect, J6).
          const [edit] = voided.changes.edited;
          const replyLeft =
            voided.changes.deleted.length > 0 || voided.changes.gone.length > 0;
          const body = edit === undefined ? (read?.body ?? null) : edit.body;
          const rejudge =
            row.grade === "m1_engaged" &&
            !replyLeft &&
            options.final !== true &&
            body !== null
              ? {
                  body,
                  editMark: voided.changes.editMarks[ts ?? ""] ?? null,
                  readAt: voided.at,
                }
              : null;
          if (rejudge !== null) {
            // The voided call's row beside the reply's, which waits for its
            // judgment again.
            await tx.execute(sql`
              INSERT INTO conversation_judgments (
                id, workspace_id, agent_id, conversation_id, grade,
                slack_team_id, slack_channel_id, refs, release_id, call_key,
                attempts, prompt_version, outcome, reason, rule_decision,
                rule_reason, claimed_at, created_at, judged_at
              )
              SELECT ${randomUUID()}::uuid, workspace_id, agent_id,
                conversation_id, grade, slack_team_id, slack_channel_id,
                '{}'::text[], ${record.releaseId}, ${record.callKey},
                ${record.attempts}, prompt_version, 'voided',
                ${voided.reason}, rule_decision, rule_reason, claimed_at,
                created_at, now()
              FROM conversation_judgments WHERE id = ${id}::uuid`);
            return { voided: voided.reason, rejudge };
          }
          if (row.grade === "m1_engaged" && row.input_id !== null) {
            await dropBufferedInputs(tx, [row.input_id]);
          }
          await tx.execute(sql`
            UPDATE conversation_judgments SET
              refs = '{}'::text[], sources = NULL, input_id = NULL,
              release_id = ${record.releaseId}, call_key = ${record.callKey},
              attempts = ${record.attempts}, outcome = 'voided',
              decision = NULL, reason = ${voided.reason}, judged_at = now()
            WHERE id = ${id}::uuid AND outcome IS NULL`);
          return { voided: voided.reason, rejudge: null };
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
