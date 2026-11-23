import { randomUUID } from "node:crypto";
import {
  type ConversationId,
  type ConversationTopicId,
  slackChannelNameSchema,
  slackScopeSegmentSchema,
  slackTsSchema,
} from "@werft-ai/contracts";
import type {
  ChannelConversationKey,
  Conversation,
  ConversationKey,
  ConversationStore,
  ConversationTopic,
  ThreadAlias,
} from "@werft-ai/platform";
import { and, eq, ne, sql } from "drizzle-orm";
import type { Database } from "../queries.ts";
import {
  channelContexts,
  conversations,
  conversationTopics,
} from "../schema.ts";

type ConversationRow = typeof conversations.$inferSelect;

// Postgres takes a uuid in either case and hands it back in lower case, so
// ids are compared in lower case.
function lowerIds(key: ConversationKey): ConversationKey {
  const ids = {
    workspaceId: key.workspaceId.toLowerCase(),
    agentId: key.agentId.toLowerCase(),
  };
  return key.kind === "channel"
    ? { ...key, ...ids }
    : { ...key, ...ids, personUserId: key.personUserId.toLowerCase() };
}

function toConversation(row: ConversationRow): Conversation {
  const id = row.id as ConversationId;
  const base = { id, workspaceId: row.workspaceId, agentId: row.agentId };
  if (row.kind === "channel" && row.teamId && row.channelId) {
    return {
      ...base,
      kind: "channel",
      teamId: row.teamId,
      channelId: row.channelId,
    };
  }
  if (row.kind === "dm" && row.personUserId) {
    return { ...base, kind: "dm", personUserId: row.personUserId };
  }
  throw new Error(`conversation ${row.id} breaks its place check`);
}

export function createPostgresConversationStore(
  db: Database,
): ConversationStore {
  // An insert that loses a race inserts nothing; the winner's row is read by
  // the next statement, which sees what committed before it began.
  async function findOrCreateConversation(
    input: ConversationKey,
  ): Promise<Conversation> {
    const key = lowerIds(input);
    const id = randomUUID();
    if (key.kind === "channel") {
      const teamId = slackScopeSegmentSchema.parse(key.teamId);
      const channelId = slackScopeSegmentSchema.parse(key.channelId);
      await db
        .insert(channelContexts)
        .values({
          id: randomUUID(),
          workspaceId: key.workspaceId,
          teamId,
          channelId,
        })
        .onConflictDoNothing({
          target: [
            channelContexts.workspaceId,
            channelContexts.teamId,
            channelContexts.channelId,
          ],
        });
      await db
        .insert(conversations)
        .values({
          id,
          workspaceId: key.workspaceId,
          agentId: key.agentId,
          kind: "channel",
          teamId,
          channelId,
        })
        .onConflictDoNothing({
          target: [
            conversations.agentId,
            conversations.teamId,
            conversations.channelId,
          ],
        });
    } else {
      await db
        .insert(conversations)
        .values({
          id,
          workspaceId: key.workspaceId,
          agentId: key.agentId,
          kind: "dm",
          personUserId: key.personUserId,
        })
        .onConflictDoNothing({
          target: [conversations.agentId, conversations.personUserId],
        });
    }
    const [row] = await db
      .select()
      .from(conversations)
      .where(
        key.kind === "channel"
          ? and(
              eq(conversations.agentId, key.agentId),
              eq(conversations.kind, "channel"),
              eq(conversations.teamId, key.teamId),
              eq(conversations.channelId, key.channelId),
            )
          : and(
              eq(conversations.agentId, key.agentId),
              eq(conversations.kind, "dm"),
              eq(conversations.personUserId, key.personUserId),
            ),
      );
    if (!row) throw new Error("conversation row is missing after its insert");
    // The agent's own workspace is what the FK held the row to; a key naming
    // another one found a row it does not own.
    if (row.workspaceId !== key.workspaceId) {
      throw new Error(
        `agent ${key.agentId} is not in workspace ${key.workspaceId}`,
      );
    }
    return toConversation(row);
  }

  async function findOrCreateThreadTopic(
    givenId: ConversationId,
    thread: ThreadAlias,
  ): Promise<ConversationTopic> {
    const conversationId = givenId.toLowerCase() as ConversationId;
    const alias = {
      slackTeamId: slackScopeSegmentSchema.parse(thread.teamId),
      slackChannelId: slackScopeSegmentSchema.parse(thread.channelId),
      slackThreadTs: slackTsSchema.parse(thread.threadTs),
    };
    // A conversation's place never changes, so reading it first races with
    // nothing.
    const [conversation] = await db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversationId));
    if (!conversation) {
      throw new Error(`conversation ${conversationId} does not exist`);
    }
    if (
      conversation.kind === "channel" &&
      (conversation.teamId !== alias.slackTeamId ||
        conversation.channelId !== alias.slackChannelId)
    ) {
      throw new Error(
        `thread ${alias.slackChannelId}/${alias.slackThreadTs} is not in the channel of conversation ${conversationId}`,
      );
    }
    await db
      .insert(conversationTopics)
      .values({
        id: randomUUID(),
        workspaceId: conversation.workspaceId,
        agentId: conversation.agentId,
        conversationId,
        conversationKind: conversation.kind,
        ...alias,
      })
      .onConflictDoNothing({
        target: [
          conversationTopics.agentId,
          conversationTopics.slackTeamId,
          conversationTopics.slackChannelId,
          conversationTopics.slackThreadTs,
        ],
      });
    const [topic] = await db
      .select()
      .from(conversationTopics)
      .where(
        and(
          eq(conversationTopics.agentId, conversation.agentId),
          eq(conversationTopics.slackTeamId, alias.slackTeamId),
          eq(conversationTopics.slackChannelId, alias.slackChannelId),
          eq(conversationTopics.slackThreadTs, alias.slackThreadTs),
        ),
      );
    if (!topic) throw new Error("topic row is missing after its insert");
    if (topic.conversationId !== conversationId) {
      throw new Error(
        `thread ${alias.slackChannelId}/${alias.slackThreadTs} is a topic of conversation ${topic.conversationId}`,
      );
    }
    return {
      id: topic.id as ConversationTopicId,
      conversationId,
      thread: {
        teamId: alias.slackTeamId,
        channelId: alias.slackChannelId,
        threadTs: alias.slackThreadTs,
      },
    };
  }

  const channelRow = (key: ChannelConversationKey) =>
    and(
      eq(conversations.workspaceId, key.workspaceId.toLowerCase()),
      eq(conversations.agentId, key.agentId.toLowerCase()),
      eq(conversations.kind, "channel"),
      eq(conversations.teamId, slackScopeSegmentSchema.parse(key.teamId)),
      eq(conversations.channelId, slackScopeSegmentSchema.parse(key.channelId)),
    );

  // A deletion is final, so it applies whatever its time; an archive or an
  // unarchive applies only when no later one was noted. An equal time passes,
  // since a retried event runs its effect again.
  async function recordChannelState(
    key: ChannelConversationKey,
    state: "archived" | "deleted" | "unarchived",
    at: number | null,
  ): Promise<boolean> {
    const next = state === "unarchived" ? "active" : state;
    const newer =
      at === null || state === "deleted"
        ? undefined
        : sql`(${conversations.channelStateUs} IS NULL OR ${conversations.channelStateUs} <= ${at})`;
    const rows = await db
      .update(conversations)
      .set({
        channelState: next,
        channelStateUs:
          at === null
            ? sql`${conversations.channelStateUs}`
            : sql`GREATEST(COALESCE(${conversations.channelStateUs}, 0), ${at}::bigint)`,
      })
      .where(
        and(channelRow(key), ne(conversations.channelState, "deleted"), newer),
      )
      .returning({ id: conversations.id });
    return rows.length > 0;
  }

  async function recordChannelName(
    key: ChannelConversationKey,
    name: string,
    at: number | null,
  ): Promise<boolean> {
    const channelName = slackChannelNameSchema.parse(name);
    const rows = await db
      .update(conversations)
      .set({
        channelName,
        channelNameUs: at === null ? sql`${conversations.channelNameUs}` : at,
      })
      .where(
        and(
          channelRow(key),
          at === null
            ? undefined
            : sql`(${conversations.channelNameUs} IS NULL OR ${conversations.channelNameUs} <= ${at})`,
        ),
      )
      .returning({ id: conversations.id });
    return rows.length > 0;
  }

  return {
    findOrCreateConversation,
    findOrCreateThreadTopic,
    recordChannelState,
    recordChannelName,
  };
}
