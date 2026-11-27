import { randomUUID } from "node:crypto";
import {
  type ConversationId,
  type ConversationInputId,
  type ConversationJudgmentId,
  type ConversationTopicId,
  conversationJudgmentIdSchema,
  type JudgmentVoidedReason,
  M1_PROMPT_VERSION,
} from "@werft-ai/contracts";
import {
  type ClaimedReplyJudgment,
  JUDGMENT_BATCH_DEADLINE_MS,
  type JudgmentAnswerStore,
  M1_CHANNEL_WINDOW_MS,
  type M1JudgmentStore,
  type M1Place,
  type M1Record,
  type SummaryFoldStore,
  storedSourceSet,
} from "@werft-ai/platform";
import { type SQL, sql } from "drizzle-orm";
import {
  appendChannelSummaryLines,
  channelMarksSettledAt,
  createChannelSummaryFoldStore,
  dropBufferedInputs,
  dropTopicIfEmpty,
  engagedJudgmentsInWindow,
  JUDGMENT_BUFFER_TTL_MS,
  lockedReadChanges,
  m1ChannelCap,
  type ReadChanges,
  type ReadMessage,
} from "../conversations/index.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { conversationGate } from "./conversation-rollout.ts";

const secs = (ms: number) => sql`make_interval(secs => ${ms / 1000})`;

/**
 * The gate a judgment passes before its call and again before its record:
 * the switch raised, and the channel not shared with another organization.
 * With `lock`, in the writing transaction, a lowering waits for the write or
 * is seen by it.
 */
async function gateOpenIn(
  db: Database,
  place: M1Place,
  lock: boolean,
): Promise<boolean> {
  const gate = await conversationGate(db, place, { lock });
  if (!gate.open) return false;
  // Locked, a share recorded meanwhile waits for the write, whose rows its
  // buffer drop then finds. An emergency stop of the agent in the channel
  // closes it too, so no judgment is asked or called while it holds.
  const bindings = rowsOf<{ external_shared: boolean; stopped: boolean }>(
    await db.execute(sql`
      SELECT b.external_shared,
        (b.emergency_stopped_at IS NOT NULL AND i.team_id = ${place.teamId}) AS stopped
      FROM surface_bindings b
      JOIN slack_installations i ON i.id = b.installation_id
      WHERE b.agent_id = ${place.agentId}::uuid AND b.surface = 'slack'
        AND b.external_surface_id = ${place.channelId}
      ORDER BY b.id
      ${lock ? sql`FOR SHARE OF b` : sql``}`),
  );
  return !bindings.some(
    (binding) => binding.external_shared || binding.stopped,
  );
}

/**
 * The gate a reply's waiting judgment is written under, in the transaction
 * that receives it: closed, the reply asks for no judgment.
 */
export function m1GateOpenForWrite(
  tx: Database,
  place: M1Place,
): Promise<boolean> {
  return gateOpenIn(tx, place, true);
}

/** A record's verdict and what it read, as its columns hold them. */
/**
 * The post a record's unasked turn answers, when the agent's rollout is
 * `on`: its buffered row goes with the others, and its topic stays for the
 * turn, written after this record. Read under the gate's lock on the agent.
 */
async function unaskedTurnPost(
  tx: Database,
  agentId: string,
  target: string | null,
  posts: readonly { inputId: string; ts: string }[],
): Promise<string | undefined> {
  const post = posts.find((each) => each.ts === target);
  if (post === undefined) return undefined;
  const [agent] = rowsOf<{ on: boolean }>(
    await tx.execute(sql`
      SELECT conversation_rollout = 'on' AS on FROM agents
      WHERE id = ${agentId}::uuid`),
  );
  return agent?.on === true ? post.inputId : undefined;
}

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
    // What a speak answers; a record that kept quiet names none.
    target: record.verdict.decision === "speak" ? record.target : null,
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
 * Whether no agent's binding of the channel is gone; read with the summary's
 * row held, after any channel delete that took it first has ended.
 */
async function channelThere(
  tx: Database,
  place: Pick<M1Place, "workspaceId" | "teamId" | "channelId">,
): Promise<boolean> {
  return (
    rowsOf(
      await tx.execute(sql`
        SELECT 1 FROM surface_bindings b
        JOIN slack_installations i ON i.id = b.installation_id
        WHERE b.workspace_id = ${place.workspaceId}::uuid
          AND b.surface = 'slack' AND i.team_id = ${place.teamId}
          AND b.external_surface_id = ${place.channelId}
          AND b.revoked_at IS NULL AND b.status = 'gone'
        LIMIT 1`),
    ).length === 0
  );
}

/**
 * M1's judgment records over PostgreSQL. A record holds Slack ts, codes and
 * ids; a held reply's text goes once it is judged or given up.
 */
export function createPostgresM1JudgmentStore(db: Database): M1JudgmentStore {
  return {
    gateOpen: (place) => gateOpenIn(db, place, false),

    async writeSummaryLine(batch, line) {
      try {
        return await db.transaction(async (tx) => {
          // Locks: the sources' marks, this agent's binding (the gate), the
          // summary's row, as a record takes the marks, then the gate, and a
          // channel delete its binding, then the summary's row. A delete of
          // any agent's, committed first, keeps the summary gone: its binding
          // is read with the row held, after that delete ends.
          const written = await appendChannelSummaryLines(tx, {
            gateOpen: () => gateOpenIn(tx, batch, true),
            channelThere: () => channelThere(tx, batch),
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
        if (!(await gateOpenIn(tx, batch, true))) {
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
        const judgmentId = conversationJudgmentIdSchema.parse(randomUUID());
        await tx.execute(sql`
          INSERT INTO conversation_judgments (
            id, workspace_id, agent_id, conversation_id, grade,
            slack_team_id, slack_channel_id, refs, sources,
            judgment_batch_id, release_id, call_key, attempts,
            prompt_version, outcome, decision, reason, summary, target_ts,
            judged_at
          ) VALUES (
            ${judgmentId}::uuid, ${batch.workspaceId}::uuid,
            ${batch.agentId}::uuid, ${batch.conversationId}::uuid,
            'buffer_m1', ${batch.teamId}, ${batch.channelId},
            ${textArray(record.refs)}, ${columns.sources}::jsonb,
            ${batch.id}::uuid, ${record.releaseId}, ${record.callKey},
            ${record.attempts}, ${M1_PROMPT_VERSION}, ${columns.outcome},
            ${columns.decision}, ${columns.reason}, ${record.summary},
            ${columns.target}, now()
          )`);
        await dropBufferedInputs(
          tx,
          judged.map((post) => post.inputId),
          await unaskedTurnPost(tx, batch.agentId, columns.target, judged),
        );
        return { outcome: "written", judgmentId };
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
        if (record === null || !(await gateOpenIn(tx, place, true))) {
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
        const columns = verdictColumns(record);
        if (row.grade === "m1_engaged" && row.input_id !== null) {
          // An engaged reply's speak answers the reply itself.
          await dropBufferedInputs(
            tx,
            [row.input_id],
            await unaskedTurnPost(tx, row.agent_id, columns.target, [
              { inputId: row.input_id, ts: columns.target ?? "" },
            ]),
          );
        }
        const written = rowsOf(
          await tx.execute(sql`
            UPDATE conversation_judgments SET
              sources = ${columns.sources}::jsonb,
              release_id = ${record.releaseId}, call_key = ${record.callKey},
              attempts = ${record.attempts}, outcome = ${columns.outcome},
              decision = ${columns.decision}, reason = ${columns.reason},
              target_ts = ${columns.target}, judged_at = now()
            WHERE id = ${id}::uuid AND outcome IS NULL
            RETURNING id`),
        );
        return written.length > 0 ? "written" : "dropped";
      });
    },
  };
}

/**
 * What became of M1's judgments that spoke (v1-b/U1), on their records:
 * each written once, so a pass that runs again changes nothing.
 */
export function createPostgresJudgmentAnswers(
  db: Database,
): JudgmentAnswerStore {
  return {
    async notStarted(judgmentId, answer) {
      await db.execute(sql`
        UPDATE conversation_judgments SET answer = ${answer}
        WHERE id = ${judgmentId}::uuid AND target_ts IS NOT NULL
          AND turn_id IS NULL AND answer IS NULL`);
    },

    async topicUnused(topicId) {
      await db.transaction((tx) => dropTopicIfEmpty(tx, topicId));
    },

    async ended(turnId) {
      // Read off the ended turn: its decision, or the refusal its permit
      // kept. A turn a delete voided answered nothing.
      const written = rowsOf(
        await db.execute(sql`
          UPDATE conversation_judgments j SET answer = CASE
              WHEN t.state = 'decided' AND t.decision = 'reply' THEN 'replied'
              WHEN t.state = 'decided' THEN 'no_reply'
              WHEN t.state = 'voided_by_delete' THEN 'source_deleted'
              WHEN p.refusal = 'budget' THEN 'budget_refused'
              ELSE 'no_decision'
            END
          FROM conversation_turns t
          LEFT JOIN conversation_turn_permits p ON p.turn_id = t.id
          WHERE t.id = ${turnId}::uuid AND j.turn_id = t.id
            AND t.state <> 'running' AND j.answer IS NULL
          RETURNING j.id`),
      );
      return written.length > 0;
    },
  };
}

/**
 * A channel summary's fold (a1/J10) over PostgreSQL. Its write asks the
 * folding agent's gate again under the agent's row, then holds the
 * summary's row, as a line's write does; once any agent's binding of the
 * channel is gone it writes nothing.
 */
export function createPostgresSummaryFoldStore(db: Database): SummaryFoldStore {
  return createChannelSummaryFoldStore(db, {
    gateOpen: (tx, subject) => gateOpenIn(tx, subject, true),
    channelThere: (tx, subject) => channelThere(tx, subject),
  });
}
