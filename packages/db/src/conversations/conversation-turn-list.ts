import {
  type ConversationTurnItem,
  type ConversationTurnRequester,
  slackMessageUrl,
} from "@werft-ai/contracts";
import type { ConversationTurnListStore } from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import {
  decodeCreatedAtCursor,
  encodeCreatedAtCursor,
  rethrowCursorCastError,
} from "../cursors.ts";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";

// A turn's Slack channel: its topic's, or a channel conversation's for a
// web topic Slack has not placed. Null for a web topic of a DM.
const FROM_TURNS = sql`
  FROM conversation_turns ct
  JOIN conversations c ON c.id = ct.conversation_id
  LEFT JOIN conversation_topics tp ON tp.id = ct.topic_id
  CROSS JOIN LATERAL (
    SELECT COALESCE(tp.slack_team_id, c.team_id) AS team_id,
      COALESCE(tp.slack_channel_id, c.channel_id) AS channel_id
  ) place`;

const agentTurns = (workspaceId: string, agentId: string) => sql`
  ct.workspace_id = ${workspaceId}::uuid
  AND ct.agent_id = ${agentId}::uuid
  AND c.agent_id = ${agentId}::uuid
  -- A web input's holder row never runs; its turn is a row of its own.
  AND ct.origin = 'm2'`;

type PageRow = {
  id: ConversationTurnItem["id"];
  cursor_at: string;
  created_at: Date | string;
  ended_at: Date | string | null;
  state: ConversationTurnItem["state"];
  limit_reached: NonNullable<ConversationTurnItem["limit"]>["reached"] | null;
  limit_reached_by: NonNullable<ConversationTurnItem["limit"]>["by"] | null;
  requester_kind: ConversationTurnRequester["kind"];
  requester_id: string;
  decision: ConversationTurnItem["decision"];
  team_id: string | null;
  channel_id: string | null;
  thread_ts: string | null;
  models: string[] | null;
  input_tokens: string | number;
  output_tokens: string | number;
  cost_usd: string;
  unpriced_calls: string | number;
  session_id: string | null;
};

const iso = (value: Date | string) => new Date(value).toISOString();

function requesterOf(row: PageRow): ConversationTurnRequester {
  return row.requester_kind === "user"
    ? { kind: "user", user_id: row.requester_id }
    : { kind: row.requester_kind };
}

export function createPostgresConversationTurnListStore(
  db: Database,
): ConversationTurnListStore {
  return {
    async page(input) {
      const cursor = input.cursor ? decodeCreatedAtCursor(input.cursor) : null;
      const rows = rowsOf<PageRow>(
        await db
          .execute(
            sql`
            SELECT ct.id, ct.created_at::text AS cursor_at, ct.created_at,
              ct.ended_at, ct.state, ct.limit_reached, ct.limit_reached_by,
              ct.requester_kind, ct.requester_id, ct.decision,
              place.team_id, place.channel_id, tp.slack_thread_ts AS thread_ts,
              calls.models, calls.input_tokens, calls.output_tokens,
              calls.cost_usd, calls.unpriced_calls, link.session_id
            ${FROM_TURNS}
            CROSS JOIN LATERAL (
              SELECT
                (SELECT array_agg(m.model ORDER BY m.first_at, m.model)
                  FROM (SELECT model, min(created_at) AS first_at
                    FROM conversation_calls
                    WHERE conversation_turn_id = ct.id GROUP BY model) m
                ) AS models,
                COALESCE(sum((cc.usage->>'inputTokens')::bigint)
                  FILTER (WHERE cc.state = 'settled'), 0) AS input_tokens,
                COALESCE(sum((cc.usage->>'outputTokens')::bigint)
                  FILTER (WHERE cc.state = 'settled'), 0) AS output_tokens,
                COALESCE(sum(cc.cost_usd)
                  FILTER (WHERE cc.state = 'settled'), 0)::text AS cost_usd,
                count(*) FILTER (
                  WHERE cc.state IN ('reserved', 'in_flight', 'resolved')
                ) AS unpriced_calls
              FROM conversation_calls cc WHERE cc.conversation_turn_id = ct.id
            ) calls
            LEFT JOIN LATERAL (
              SELECT sl.session_id FROM session_links sl
              WHERE sl.workspace_id = ct.workspace_id
                AND sl.agent_id = ct.agent_id
                AND sl.channel_id = tp.slack_channel_id
                AND sl.thread_id = tp.slack_thread_ts
                AND sl.session_id IS NOT NULL
                AND sl.closed_at IS NULL AND sl.revoked_at IS NULL
              ORDER BY sl.created_at DESC, sl.id DESC LIMIT 1
            ) link ON true
            WHERE ${agentTurns(input.workspaceId, input.agentId)}
              ${
                input.rootKinds === null
                  ? sql``
                  : sql`AND EXISTS (
                      SELECT 1 FROM conversation_turn_permits p
                      WHERE p.turn_id = ct.id
                        AND p.root_kind IN (${sql.join(
                          input.rootKinds.map((kind) => sql`${kind}`),
                          sql`, `,
                        )}))`
              }
              ${
                cursor === null
                  ? sql``
                  : sql`AND (ct.created_at, ct.id) < (${cursor.created_at}::timestamptz, ${cursor.id}::uuid)`
              }
            ORDER BY ct.created_at DESC, ct.id DESC
            LIMIT ${input.limit + 1}`,
          )
          .catch(rethrowCursorCastError),
      );
      const page = rows.slice(0, input.limit);
      const last = page[page.length - 1];
      return {
        items: page.map((row) => ({
          id: row.id,
          started_at: iso(row.created_at),
          ended_at: row.ended_at === null ? null : iso(row.ended_at),
          state: row.state,
          limit:
            row.limit_reached === null || row.limit_reached_by === null
              ? null
              : { reached: row.limit_reached, by: row.limit_reached_by },
          requester: requesterOf(row),
          decision: row.decision,
          models: row.models ?? [],
          input_tokens: Number(row.input_tokens),
          output_tokens: Number(row.output_tokens),
          cost_usd: row.cost_usd,
          unpriced_calls: Number(row.unpriced_calls),
          slack_thread:
            row.team_id === null ||
            row.channel_id === null ||
            row.thread_ts === null
              ? null
              : {
                  team_id: row.team_id,
                  channel_id: row.channel_id,
                  thread_ts: row.thread_ts,
                  url: slackMessageUrl(row.channel_id, row.thread_ts),
                },
          thread_task_session_id: row.session_id,
        })),
        nextCursor:
          rows.length > input.limit && last
            ? encodeCreatedAtCursor({ created_at: last.cursor_at, id: last.id })
            : null,
      };
    },
  };
}
