import {
  CONVERSATION_TURN_THREAD_READ_LIMIT,
  CONVERSATION_TURN_TOOL_CALL_LIMIT,
  type ConversationId,
  type ConversationTopicId,
  type ConversationTurnDecision,
  type ConversationTurnId,
  ENDED_SESSION_STATUSES,
} from "@werft-ai/contracts";
import {
  type ConversationReadToolStore,
  type ConversationToolTurn,
  type SourcePlace,
  sourceSetOf,
  storedSourceSet,
  withDirectSources,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import { channelKindOf, sessionVisibleTo } from "../musterrolle/index.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { lockedTurnReadDeleted } from "./conversation-turns.ts";
import { directSourceDeletedAt, servedTitle } from "./deleted-sources.ts";
import { turnAnswerTexts } from "./input-texts.ts";

type AdmitRow = {
  state: string;
  lease_id: string | null;
  runtime_id: string | null;
  lease_expires_at: Date | string | null;
  workspace_id: string;
  agent_id: string;
  conversation_id: ConversationId;
  topic_id: ConversationTopicId;
  requester_kind: string;
  requester_id: string;
  slack_installation_id: string | null;
  kind: "channel" | "dm";
  team_id: string | null;
  channel_id: string | null;
  person_user_id: string | null;
  channel_kind: string | null;
  slack_team_id: string | null;
  slack_channel_id: string | null;
  slack_thread_ts: string | null;
  tool_calls: number;
  thread_reads: number;
};

function toolTurnOf(
  turnId: ConversationTurnId,
  row: AdmitRow,
): ConversationToolTurn {
  return {
    turnId,
    workspaceId: row.workspace_id,
    agentId: row.agent_id,
    conversationId: row.conversation_id,
    topicId: row.topic_id,
    requester: { kind: row.requester_kind, id: row.requester_id },
    slackInstallationId: row.slack_installation_id,
    place:
      row.kind === "channel"
        ? {
            kind: "channel",
            teamId: row.team_id as string,
            channelId: row.channel_id as string,
            private: row.channel_kind !== "public_channel",
          }
        : { kind: "dm", personUserId: row.person_user_id as string },
    thread:
      row.slack_team_id !== null &&
      row.slack_channel_id !== null &&
      row.slack_thread_ts !== null
        ? {
            teamId: row.slack_team_id,
            channelId: row.slack_channel_id,
            ts: row.slack_thread_ts,
          }
        : null,
  };
}

/** Every source of a stored set, as directSourceDeletedAt reads direct ones. */
const allSources = (sources: string) =>
  sql.raw(
    `jsonb_build_object('direct', COALESCE(${sources} -> 'direct', '[]'::jsonb) || COALESCE(${sources} -> 'inherited', '[]'::jsonb))`,
  );

/**
 * The read tools' side of the database. A call is admitted, and counted, in
 * one transaction holding the turn's permit, so every API process holds a
 * turn to the same counts.
 */
export function createPostgresConversationReadToolStore(
  db: Database,
): ConversationReadToolStore {
  return {
    admit(input) {
      return db.transaction(async (tx) => {
        const [row] = rowsOf<AdmitRow>(
          await tx.execute(sql`
            SELECT q.state, q.lease_id, q.runtime_id, q.lease_expires_at,
              t.workspace_id, t.agent_id, t.conversation_id, t.topic_id,
              t.requester_kind, t.requester_id, t.slack_installation_id,
              c.kind, c.team_id, c.channel_id, c.person_user_id,
              ${channelKindOf(sql`c`)} AS channel_kind,
              tp.slack_team_id, tp.slack_channel_id, tp.slack_thread_ts,
              p.tool_calls, p.thread_reads
            FROM conversation_turn_queue q
            JOIN conversation_turns t ON t.id = q.turn_id
            JOIN conversations c ON c.id = t.conversation_id
              AND c.workspace_id = t.workspace_id AND c.agent_id = t.agent_id
            JOIN conversation_topics tp ON tp.id = t.topic_id
              AND tp.conversation_id = c.id
            JOIN conversation_turn_permits p ON p.turn_id = q.turn_id
            WHERE q.turn_id = ${input.turnId}::uuid
            FOR UPDATE OF p`),
        );
        if (row === undefined) return { outcome: "unknown_turn" };
        if (
          row.state !== "leased" ||
          row.lease_id !== input.leaseId ||
          row.runtime_id !== input.runtimeId
        ) {
          return { outcome: "not_holder" };
        }
        if (
          row.lease_expires_at === null ||
          new Date(row.lease_expires_at).getTime() <= input.now.getTime()
        ) {
          return { outcome: "lease_expired" };
        }
        // A turn ends on one decision: no tool call after it. Its own
        // statement, as one written while this waited on the permit reads as
        // running in the statement that took it.
        const [turn] = rowsOf<{ state: string }>(
          await tx.execute(sql`
            SELECT state FROM conversation_turns
            WHERE id = ${input.turnId}::uuid`),
        );
        if (turn?.state !== "running") return { outcome: "not_holder" };
        const toolCalls = row.tool_calls + 1;
        const readsThread =
          input.tool === "read_thread" &&
          toolCalls <= CONVERSATION_TURN_TOOL_CALL_LIMIT &&
          row.thread_reads < CONVERSATION_TURN_THREAD_READ_LIMIT;
        // The call past the limit is counted too, which is how the turn's end
        // knows the server refused one.
        await tx.execute(sql`
          UPDATE conversation_turn_permits
          SET tool_calls = ${toolCalls},
            thread_reads = thread_reads + ${readsThread ? 1 : 0}
          WHERE turn_id = ${input.turnId}::uuid`);
        if (toolCalls > CONVERSATION_TURN_TOOL_CALL_LIMIT) {
          return { outcome: "tool_call_limit" };
        }
        if (input.tool === "read_thread" && !readsThread) {
          return { outcome: "thread_read_limit" };
        }
        return { outcome: "admitted", turn: toolTurnOf(input.turnId, row) };
      });
    },

    async recordDecision({ turnId, leaseId, runtimeId, decision }) {
      // A read that joined the sources after the check takes it all again:
      // checking under the turn's row lock would turn the lock order round.
      // Each read is a counted tool call, so the sources settle.
      for (let attempt = 0; ; attempt++) {
        const recorded = await db.transaction(async (tx) => {
          // Check spot ②, its mark locks before any row's.
          const read = await lockedTurnReadDeleted(tx, turnId);
          // The permit before the turn, as the turn's end takes them.
          await tx.execute(sql`
            SELECT 1 FROM conversation_turn_permits
            WHERE turn_id = ${turnId}::uuid FOR UPDATE`);
          const [turn] = rowsOf<{ state: string; sources: unknown }>(
            await tx.execute(sql`
              SELECT state, sources FROM conversation_turns
              WHERE id = ${turnId}::uuid AND origin = 'm2'
              FOR UPDATE`),
          );
          // The first decision of the turn is its decision.
          if (read === null || turn?.state !== "running") {
            return { outcome: "turn_not_held" as const };
          }
          // The lease or permit ran out since the call was admitted, read in
          // a statement after the locks: one that waited on them reads the
          // clock from before (db-clock.ts).
          const [held] = rowsOf<{ held: boolean }>(
            await tx.execute(sql`
              SELECT p.expires_at > clock_timestamp() AND EXISTS (
                SELECT 1 FROM conversation_turn_queue q
                WHERE q.turn_id = p.turn_id AND q.state = 'leased'
                  AND q.lease_id = ${leaseId}::uuid
                  AND q.runtime_id = ${runtimeId}::uuid
                  AND q.lease_expires_at > clock_timestamp()
              ) AS held
              FROM conversation_turn_permits p
              WHERE p.turn_id = ${turnId}::uuid`),
          );
          if (held?.held !== true) return { outcome: "turn_not_held" as const };
          if (
            JSON.stringify(read.sources ?? null) !==
            JSON.stringify(turn.sources ?? null)
          ) {
            return null;
          }
          const state: "decided" | "voided_by_delete" = read.deleted
            ? "voided_by_delete"
            : "decided";
          await tx.execute(
            state === "decided"
              ? sql`
                UPDATE conversation_turns
                SET state = 'decided', decision = ${decision.tool},
                  decision_reason = ${decision.reason},
                  answer_text = ${decision.tool === "reply" ? decision.body : null},
                  ended_at = clock_timestamp()
                WHERE id = ${turnId}::uuid`
              : sql`
                UPDATE conversation_turns
                SET state = 'voided_by_delete', ended_at = clock_timestamp()
                WHERE id = ${turnId}::uuid`,
          );
          return { outcome: "recorded" as const, state };
        });
        if (recorded !== null) return recorded;
        if (attempt >= CONVERSATION_TURN_TOOL_CALL_LIMIT) {
          throw new Error(
            `Conversation turn ${turnId}'s sources did not settle`,
          );
        }
      }
    },

    async closeThreadReads(turnId) {
      await db.execute(sql`
        UPDATE conversation_turn_permits
        SET thread_reads = GREATEST(thread_reads, ${CONVERSATION_TURN_THREAD_READ_LIMIT})
        WHERE turn_id = ${turnId}::uuid`);
    },

    addDirectSources(turnId, keys) {
      return db.transaction(async (tx) => {
        const [turn] = rowsOf<{ sources: unknown }>(
          await tx.execute(sql`
            SELECT sources FROM conversation_turns
            WHERE id = ${turnId}::uuid AND origin = 'm2' AND state = 'running'
            FOR UPDATE`),
        );
        // An ended turn's sources are what it ended with.
        if (turn === undefined) return;
        const stored = storedSourceSet(
          withDirectSources(sourceSetOf(turn.sources), keys),
        );
        await tx.execute(sql`
          UPDATE conversation_turns
          SET sources = ${stored === null ? null : JSON.stringify(stored)}::jsonb
          WHERE id = ${turnId}::uuid`);
      });
    },

    async deletedAmong(workspaceId, places) {
      if (places.length === 0) return [];
      // No mark lock: a read that misses a delete under way withholds the
      // message on the next one, and the turn's sources hold it from now.
      const rows = rowsOf<{ team_id: string; channel_id: string; ts: string }>(
        await db.execute(sql`
          SELECT team_id, channel_id, ts FROM deleted_sources
          WHERE workspace_id = ${workspaceId}::uuid
            AND (team_id, channel_id, ts) IN (${sql.join(
              places.map(
                (place) =>
                  sql`(${place.teamId}::text, ${place.channelId}::text, ${place.ts}::text)`,
              ),
              sql`, `,
            )})`),
      );
      return rows.map(
        (row): SourcePlace => ({
          teamId: row.team_id,
          channelId: row.channel_id,
          ts: row.ts,
        }),
      );
    },

    endedTurns({ turn, limit }) {
      return db.transaction(async (tx) => {
        const rows = rowsOf<{
          id: ConversationTurnId;
          topic_id: ConversationTopicId | null;
          ended_at: Date | string;
          decision: ConversationTurnDecision | null;
          decision_reason: string | null;
          sources: unknown;
        }>(
          await tx.execute(sql`
            SELECT ct.id, ct.topic_id, ct.ended_at, ct.decision,
              ct.decision_reason, ct.sources
            FROM conversation_turns ct
            WHERE ct.conversation_id = ${turn.conversationId}::uuid
              AND ct.workspace_id = ${turn.workspaceId}::uuid
              AND ct.agent_id = ${turn.agentId}::uuid
              AND ct.origin = 'm2'
              AND ct.state IN ('decided', 'no_decision')
              AND ct.ended_at IS NOT NULL
              AND ct.id <> ${turn.turnId}::uuid
              -- Past its list, a deleted source would not be seen.
              AND NOT COALESCE(ct.sources ? 'overflow', false)
              AND ${directSourceDeletedAt(allSources("ct.sources"), sql`ct.workspace_id`)} IS NULL
            ORDER BY ct.ended_at DESC, ct.id DESC
            LIMIT ${limit}`),
        );
        const answers = await turnAnswerTexts(
          tx,
          rows.map((row) => row.id),
        );
        return rows.map((row) => {
          const set = sourceSetOf(row.sources);
          return {
            turnId: row.id,
            topicId: row.topic_id,
            endedAt: new Date(row.ended_at),
            decision: row.decision,
            reason: row.decision_reason,
            answer: answers.get(row.id) ?? null,
            sources: [...set.direct, ...set.inherited],
          };
        });
      });
    },

    async openTasks({ turn, viewer, limit }) {
      // Qualified by the table's own name: sessionVisibleTo reads it so.
      const visible =
        viewer === null
          ? sql`coalesce((SELECT ss.scope FROM session_shares ss WHERE ss.session_id = sessions.id), 'workspace') IN ('workspace', 'private_channel')`
          : sessionVisibleTo(db, viewer);
      const rows = rowsOf<{
        id: string;
        title: string | null;
        title_sources: unknown;
        status: string;
        created_at: Date | string;
      }>(
        await db.execute(sql`
          SELECT sessions.id, ${servedTitle("sessions")} AS title,
            CASE WHEN sessions.title_source IN ('derived', 'generated') THEN (
              SELECT tt.sources FROM turns tt
              WHERE tt.session_id = sessions.id AND tt.sequence = 1
            ) END AS title_sources,
            sessions.status, sessions.created_at
          FROM sessions
          WHERE sessions.workspace_id = ${turn.workspaceId}::uuid
            AND sessions.parent_conversation_id = ${turn.conversationId}::uuid
            AND sessions.status::text NOT IN (${sql.join(
              ENDED_SESSION_STATUSES.map((status) => sql`${status}`),
              sql`, `,
            )})
            AND ${visible}
          ORDER BY sessions.created_at DESC, sessions.id DESC
          LIMIT ${limit}`),
      );
      return rows.map((row) => {
        const set = sourceSetOf(row.title_sources);
        // Past its list, a deleted source of the title would not be seen.
        const shown = row.title !== null && !set.overflow;
        return {
          sessionId: row.id,
          title: shown ? row.title : null,
          titleSources: shown ? [...set.direct, ...set.inherited] : [],
          status: row.status,
          createdAt: new Date(row.created_at),
        };
      });
    },

    async previousTurn({ workspaceId, topicId, turnId }) {
      const [row] = rowsOf<{
        id: ConversationTurnId;
        ended_at: Date | string | null;
        sources: unknown;
      }>(
        await db.execute(sql`
          SELECT id, ended_at, sources FROM conversation_turns
          WHERE topic_id = ${topicId}::uuid
            AND workspace_id = ${workspaceId}::uuid
            AND origin = 'm2'
            AND id <> ${turnId}::uuid
          ORDER BY created_at DESC, id DESC
          LIMIT 1`),
      );
      if (row === undefined) return null;
      const set = sourceSetOf(row.sources);
      return {
        turnId: row.id,
        ended: row.ended_at !== null,
        sources: [...set.direct, ...set.inherited],
        overflow: set.overflow,
      };
    },
  };
}
