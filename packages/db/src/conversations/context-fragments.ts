import {
  type ConversationInputId,
  type ConversationTurnId,
  type EngagementKind,
  type ScopeKey,
  scopeKeyOf,
} from "@werft-ai/contracts";
import {
  type ContextFragment,
  type ContextFragmentSource,
  type ContextRead,
  type ConversationKey,
  type SourceKey,
  storedSourceSet,
} from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import { rowsOf } from "../statement-rows.ts";
import { createPostgresChannelSummaryStore } from "./channel-summaries.ts";
import { lockedDeletedSource } from "./deleted-sources.ts";
import { inputTexts } from "./input-texts.ts";

/** The conversation columns a fragment's scope is read off. */
type ConversationColumns = {
  workspace_id: string;
  agent_id: string;
  kind: "channel" | "dm";
  team_id: string | null;
  channel_id: string | null;
  person_user_id: string | null;
};

/** The scope of the conversation row a fragment hangs off. */
function scopeOfRow(row: ConversationColumns): ScopeKey {
  return row.kind === "channel"
    ? scopeKeyOf({
        kind: "channel",
        workspaceId: row.workspace_id,
        teamId: row.team_id as string,
        channelId: row.channel_id as string,
      })
    : scopeKeyOf({
        kind: "person",
        workspaceId: row.workspace_id,
        userId: row.person_user_id as string,
      });
}

const conversationColumns = (alias: string) => {
  const c = sql.raw(alias);
  return sql`${c}.workspace_id, ${c}.agent_id, ${c}.kind, ${c}.team_id,
    ${c}.channel_id, ${c}.person_user_id`;
};

export function createPostgresContextFragmentSource(
  db: Database,
): ContextFragmentSource {
  return {
    read(key: ConversationKey): Promise<ContextRead> {
      return db.transaction(async (tx) => {
        const [conversation] = rowsOf<ConversationColumns & { id: string }>(
          await tx.execute(sql`
            SELECT c.id, ${conversationColumns("c")} FROM conversations c
            WHERE c.workspace_id = ${key.workspaceId}::uuid
              AND c.agent_id = ${key.agentId}::uuid
              AND c.kind = ${key.kind}
              AND ${
                key.kind === "channel"
                  ? sql`c.team_id = ${key.teamId} AND c.channel_id = ${key.channelId}`
                  : sql`c.person_user_id = ${key.personUserId}::uuid`
              }`),
        );
        if (conversation === undefined) return { fragments: [], unreadable: 0 };
        const fragments: ContextFragment[] = [];

        // Every agent of the channel reads its one summary (9-2).
        if (conversation.kind === "channel") {
          const place = {
            workspaceId: conversation.workspace_id,
            teamId: conversation.team_id as string,
            channelId: conversation.channel_id as string,
          };
          const summary =
            await createPostgresChannelSummaryStore(tx).read(place);
          const scope = scopeKeyOf({ kind: "channel", ...place });
          for (const line of summary?.lines ?? []) {
            fragments.push({
              kind: "channel_summary_line",
              scope,
              sources: line.sources.map((source) => ({
                inputId: source.inputId,
                slack: {
                  teamId: source.teamId,
                  channelId: source.channelId,
                  ts: source.ts,
                },
              })),
              lineId: line.id,
              text: line.text,
              writtenByAgentId: line.writtenByAgentId,
              writtenAt: line.writtenAt,
            });
          }
        }

        // An engagement is the conversation's through its session's parent
        // or its conversation turn's conversation; a channel one must be of
        // a message in that channel too.
        const engagements = rowsOf<
          ConversationColumns & {
            engagement_kind: EngagementKind;
            session_id: string | null;
            conversation_turn_id: ConversationTurnId | null;
            created_at: Date | string;
            e_team_id: string;
            e_channel_id: string;
            ts: string;
          }
        >(
          await tx.execute(sql`
            SELECT e.kind AS engagement_kind, e.session_id,
              e.conversation_turn_id, e.created_at,
              e.team_id AS e_team_id, e.channel_id AS e_channel_id, e.ts,
              ${conversationColumns("c")}
            FROM conversation_engagements e
            LEFT JOIN sessions s ON s.id = e.session_id
            LEFT JOIN conversation_turns ct ON ct.id = e.conversation_turn_id
            JOIN conversations c
              ON c.id = COALESCE(s.parent_conversation_id, ct.conversation_id)
            WHERE c.id = ${conversation.id}::uuid
              AND e.workspace_id = c.workspace_id AND e.agent_id = c.agent_id
              AND (c.kind = 'dm'
                OR (e.team_id = c.team_id AND e.channel_id = c.channel_id))
            ORDER BY e.created_at, e.ts`),
        );
        for (const row of engagements) {
          fragments.push({
            kind: "engagement",
            scope: scopeOfRow(row),
            sources: [
              {
                inputId: null,
                slack: {
                  teamId: row.e_team_id,
                  channelId: row.e_channel_id,
                  ts: row.ts,
                },
              },
            ],
            engagementKind: row.engagement_kind,
            target:
              row.session_id !== null
                ? { kind: "session", sessionId: row.session_id }
                : {
                    kind: "conversation_turn",
                    turnId: row.conversation_turn_id as ConversationTurnId,
                  },
            at: new Date(row.created_at),
          });
        }

        // A buffered message is the conversation's through its topic. One
        // whose time is up and not yet purged is not read.
        const buffered = rowsOf<
          ConversationColumns & {
            input_id: ConversationInputId;
            requester_kind: string;
            requester_id: string;
            received_at: Date | string;
            slack_team_id: string;
            slack_channel_id: string;
            slack_ts: string;
          }
        >(
          await tx.execute(sql`
            SELECT i.id AS input_id, i.requester_kind, i.requester_id,
              i.received_at, i.slack_team_id, i.slack_channel_id, i.slack_ts,
              ${conversationColumns("c")}
            FROM conversation_inputs i
            JOIN conversation_topics t ON t.id = i.topic_id
            JOIN conversations c ON c.id = t.conversation_id
            WHERE c.id = ${conversation.id}::uuid
              AND i.agent_id = c.agent_id
              AND i.buffer_expires_at > now()
            ORDER BY i.received_at, i.id`),
        );
        const texts = await inputTexts(
          tx,
          buffered.map((row) => row.input_id),
        );
        let unreadable = 0;
        for (const row of buffered) {
          const body = texts.get(row.input_id);
          if (body === undefined) {
            unreadable += 1;
            continue;
          }
          fragments.push({
            kind: "buffered_message",
            scope: scopeOfRow(row),
            sources: [
              {
                inputId: row.input_id,
                slack: {
                  teamId: row.slack_team_id,
                  channelId: row.slack_channel_id,
                  ts: row.slack_ts,
                },
              },
            ],
            inputId: row.input_id,
            body,
            poster: { kind: row.requester_kind, id: row.requester_id },
            receivedAt: new Date(row.received_at),
          });
        }

        const kept = await withoutDeletedSources(
          tx,
          conversation.workspace_id,
          fragments,
        );
        return {
          fragments: kept,
          unreadable: unreadable + fragments.length - kept.length,
        };
      });
    },
  };
}

/**
 * Check place ① (6-3): drops each fragment with a source Slack deleted. The
 * first call takes every source's mark lock, in the one order
 * lockedDeletedSource keeps, and finds whether any is deleted at all; only
 * then is each fragment judged, under locks this transaction already holds.
 */
async function withoutDeletedSources(
  tx: Database,
  workspaceId: string,
  fragments: ContextFragment[],
): Promise<ContextFragment[]> {
  const judge = (direct: SourceKey[]) =>
    lockedDeletedSource(tx, {
      workspaceId,
      sessionId: null,
      sources: storedSourceSet({ direct, inherited: [], overflow: false }),
      throughTurn: null,
    });
  const all = fragments.flatMap((fragment) => fragment.sources);
  if ((await judge(all)) === null) return fragments;
  const kept: ContextFragment[] = [];
  for (const fragment of fragments) {
    if ((await judge(fragment.sources)) === null) kept.push(fragment);
  }
  return kept;
}
