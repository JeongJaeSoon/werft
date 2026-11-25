// Test fixtures only: the rows a queued turn stands on, for the turn queue's
// contract over the database.
import { randomUUID } from "node:crypto";
import type { ConversationTopicId } from "@werft-ai/contracts";
import type { QueuedConversationTurn } from "@werft-ai/platform";
import { sql } from "drizzle-orm";
import { createPostgresConversationStore } from "../conversations/conversation-store.ts";
import { insertWebInputTurn } from "../conversations/conversation-turns.ts";
import type { Database } from "../queries.ts";
import { fixtureTeam } from "./fixture-team.ts";

const TEAM = "T0QUEUE";
const CHANNEL = "C0QUEUE";

/**
 * A workspace, an agent and a channel conversation, and a maker of turns:
 * each a `conversation_turns` row, in a new thread's topic unless given one.
 */
export async function conversationTurnQueueFixture(db: Database) {
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const userId = randomUUID();
  await db.execute(
    sql`INSERT INTO workspaces (id, slug, name) VALUES (${workspaceId}::uuid, ${`ws-${workspaceId.slice(0, 8)}`}, 'ws')`,
  );
  await db.execute(
    sql`INSERT INTO users (id, email, display_name) VALUES (${userId}::uuid, ${`${userId}@example.invalid`}, 'u')`,
  );
  const team = await fixtureTeam(db, workspaceId);
  await db.execute(
    sql`INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES (${agentId}::uuid, ${workspaceId}::uuid, ${team}::uuid, 'agent', 'agent', 'active')`,
  );
  const store = createPostgresConversationStore(db);
  const conversation = await store.findOrCreateConversation({
    kind: "channel",
    workspaceId,
    agentId,
    teamId: TEAM,
    channelId: CHANNEL,
  });
  let threads = 0;
  const newTopic = async (): Promise<ConversationTopicId> => {
    threads += 1;
    const topic = await store.findOrCreateThreadTopic(conversation.id, {
      teamId: TEAM,
      channelId: CHANNEL,
      threadTs: `1700000000.${String(threads).padStart(6, "0")}`,
    });
    return topic.id;
  };

  return {
    async turn(
      sameTopicAs?: QueuedConversationTurn,
    ): Promise<QueuedConversationTurn> {
      const topicId = sameTopicAs?.scope.topic_id ?? (await newTopic());
      const turnId = await insertWebInputTurn(db, {
        workspaceId,
        agentId,
        conversationId: conversation.id,
        topicId,
        requesterUserId: userId,
        body: "hello",
      });
      return {
        turn_id: turnId,
        scope: {
          workspace_id: workspaceId,
          agent_id: agentId,
          conversation_id: conversation.id,
          topic_id: topicId,
        },
        model: "claude-haiku-5",
        provider: {
          kind: "anthropic",
          endpoint: "https://api.anthropic.com",
          auth: {
            kind: "egress_token",
            token: ["wec", randomUUID()].join("_"),
          },
        },
        call: { max_tokens: 1_024 },
        input: { id: randomUUID(), text: "hello" },
        fresh_input: { id: randomUUID(), text: "context and hello" },
      };
    },
  };
}
