import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { type ConversationId, conversationScopeKey } from "@werft-ai/contracts";
import type { ConversationStore } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import { createPostgresConversationStore } from "./conversation-store.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("conversations and topics (0310)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let store: ConversationStore;
  const workspaceId = randomUUID();
  const otherWorkspaceId = randomUUID();
  const agentId = randomUUID();
  const secondAgentId = randomUUID();
  const otherAgentId = randomUUID();
  const member = randomUUID();
  const outsider = randomUUID();
  let channelSeq = 0;
  const nextChannel = () => `C${String(++channelSeq).padStart(6, "0")}`;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "conversations" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    store = createPostgresConversationStore(drizzle(pool, { schema }));
    for (const id of [workspaceId, otherWorkspaceId]) {
      await pool.query(
        "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
        [id, `ws-${id.slice(0, 8)}`],
      );
    }
    for (const id of [member, outsider]) {
      await pool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
        [id, `${id}@example.invalid`],
      );
    }
    await pool.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member'), ($3, $4, 'member')",
      [workspaceId, member, otherWorkspaceId, outsider],
    );
    for (const [id, workspace] of [
      [agentId, workspaceId],
      [secondAgentId, workspaceId],
      [otherAgentId, otherWorkspaceId],
    ] as const) {
      const team = await fixtureTeamSql(pool, workspace);
      await pool.query(
        "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, $4, 'agent', 'active')",
        [id, workspace, team, `agent-${id.slice(0, 8)}`],
      );
    }
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  // drizzle wraps the driver's error; the constraint is on its cause.
  async function violates(work: Promise<unknown>, constraint: string) {
    const error = await work.then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(
      (error as { cause?: { constraint?: string } } | null)?.cause?.constraint,
    ).toBe(constraint);
  }

  const count = async (table: string, where: string, values: unknown[]) => {
    const { rows } = await pool.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE ${where}`,
      values,
    );
    return rows[0]?.n as number;
  };

  describe("the channel's archive, rename and delete", () => {
    const US = 1_800_000_000_000_000;
    async function channelConversation() {
      const key = {
        kind: "channel" as const,
        workspaceId,
        agentId,
        teamId: "T0LIFE",
        channelId: nextChannel(),
      };
      const conversation = await store.findOrCreateConversation(key);
      return { key, conversation };
    }
    const row = async (id: string) =>
      (
        await pool.query(
          "SELECT channel_state, channel_state_us, channel_name, channel_name_us FROM conversations WHERE id = $1",
          [id],
        )
      ).rows[0];

    test("a new conversation is active and unnamed; archive, unarchive and delete change it in Slack's order, and delete is final", async () => {
      const { key, conversation } = await channelConversation();
      expect(await row(conversation.id)).toEqual({
        channel_state: "active",
        channel_state_us: null,
        channel_name: null,
        channel_name_us: null,
      });
      expect(await store.recordChannelState(key, "archived", US + 2)).toBe(
        true,
      );
      expect((await row(conversation.id)).channel_state).toBe("archived");
      // An unarchive Slack stamped before the archive is old news.
      expect(await store.recordChannelState(key, "unarchived", US + 1)).toBe(
        false,
      );
      expect((await row(conversation.id)).channel_state).toBe("archived");
      expect(await store.recordChannelState(key, "unarchived", US + 3)).toBe(
        true,
      );
      expect(await row(conversation.id)).toMatchObject({
        channel_state: "active",
        channel_state_us: String(US + 3),
      });
      // A retry at the same time runs again.
      expect(await store.recordChannelState(key, "unarchived", US + 3)).toBe(
        true,
      );
      // A deletion applies whatever its time, and nothing undoes it.
      expect(await store.recordChannelState(key, "deleted", US + 1)).toBe(true);
      expect(await row(conversation.id)).toMatchObject({
        channel_state: "deleted",
        channel_state_us: String(US + 3),
      });
      expect(await store.recordChannelState(key, "unarchived", US + 9)).toBe(
        false,
      );
      expect(await store.recordChannelState(key, "archived", null)).toBe(false);
      expect((await row(conversation.id)).channel_state).toBe("deleted");
    });

    test("a rename keeps the newest name; an older one changes nothing", async () => {
      const { key, conversation } = await channelConversation();
      expect(await store.recordChannelName(key, "launch", US + 5)).toBe(true);
      expect(await store.recordChannelName(key, "old-name", US + 4)).toBe(
        false,
      );
      expect(await row(conversation.id)).toMatchObject({
        channel_name: "launch",
        channel_name_us: String(US + 5),
      });
      expect(await store.recordChannelName(key, "発表", null)).toBe(true);
      expect(await row(conversation.id)).toMatchObject({
        channel_name: "発表",
        channel_name_us: String(US + 5),
      });
      await expect(store.recordChannelName(key, "", US + 6)).rejects.toThrow();
      await expect(
        store.recordChannelName(key, "x".repeat(81), US + 6),
      ).rejects.toThrow();
      // A deletion is final for the name too, even for a newer rename.
      expect(await store.recordChannelState(key, "deleted", US + 7)).toBe(true);
      expect(await store.recordChannelName(key, "after", US + 8)).toBe(false);
      expect((await row(conversation.id)).channel_name).toBe("発表");
    });

    test("no conversation is made, and another agent's or workspace's is not touched", async () => {
      const { key, conversation } = await channelConversation();
      const unseen = { ...key, channelId: nextChannel() };
      expect(await store.recordChannelState(unseen, "deleted", US)).toBe(false);
      expect(
        await count("conversations", "channel_id = $1", [unseen.channelId]),
      ).toBe(0);
      expect(
        await store.recordChannelState(
          { ...key, agentId: secondAgentId },
          "archived",
          US,
        ),
      ).toBe(false);
      expect(
        await store.recordChannelState(
          { ...key, workspaceId: otherWorkspaceId },
          "archived",
          US,
        ),
      ).toBe(false);
      expect((await row(conversation.id)).channel_state).toBe("active");
    });

    test("a DM row cannot hold a channel state or name", async () => {
      const dm = await store.findOrCreateConversation({
        kind: "dm",
        workspaceId,
        agentId,
        personUserId: member,
      });
      const refused = await pool
        .query(
          "UPDATE conversations SET channel_state = 'archived' WHERE id = $1",
          [dm.id],
        )
        .then(
          () => null,
          (error: { constraint?: string }) => error.constraint,
        );
      expect(refused).toBe("conversations_channel_state_check");
    });
  });

  test("two racing find-or-creates of one channel conversation leave one row", async () => {
    for (let round = 0; round < 5; round += 1) {
      const channelId = nextChannel();
      const key = {
        kind: "channel",
        workspaceId,
        agentId,
        teamId: "T01",
        channelId,
      } as const;
      const [a, b] = await Promise.all([
        store.findOrCreateConversation(key),
        store.findOrCreateConversation(key),
      ]);
      expect(a.id).toBe(b.id);
      expect(
        await count("conversations", "agent_id = $1 AND channel_id = $2", [
          agentId,
          channelId,
        ]),
      ).toBe(1);
      expect(
        await count("channel_contexts", "channel_id = $1", [channelId]),
      ).toBe(1);
    }
  });

  test("two racing find-or-creates of one DM conversation leave one row", async () => {
    const key = {
      kind: "dm",
      workspaceId,
      agentId: secondAgentId,
      personUserId: member,
    } as const;
    const [a, b] = await Promise.all([
      store.findOrCreateConversation(key),
      store.findOrCreateConversation(key),
    ]);
    expect(a.id).toBe(b.id);
    expect(a).toMatchObject({ kind: "dm", personUserId: member });
    expect(
      await count("conversations", "agent_id = $1 AND person_user_id = $2", [
        secondAgentId,
        member,
      ]),
    ).toBe(1);
  });

  test("two agents in one channel share its context and its scope key", async () => {
    const channelId = nextChannel();
    const place = {
      kind: "channel",
      workspaceId,
      teamId: "T01",
      channelId,
    } as const;
    const first = await store.findOrCreateConversation({ ...place, agentId });
    const second = await store.findOrCreateConversation({
      ...place,
      agentId: secondAgentId,
    });
    expect(first.id).not.toBe(second.id);
    expect(
      await count("channel_contexts", "channel_id = $1", [channelId]),
    ).toBe(1);
    expect(conversationScopeKey(first)).toBe(conversationScopeKey(second));
  });

  test("one team and channel in two workspaces are two contexts and two scopes", async () => {
    const channelId = nextChannel();
    const here = await store.findOrCreateConversation({
      kind: "channel",
      workspaceId,
      agentId,
      teamId: "T01",
      channelId,
    });
    const there = await store.findOrCreateConversation({
      kind: "channel",
      workspaceId: otherWorkspaceId,
      agentId: otherAgentId,
      teamId: "T01",
      channelId,
    });
    expect(
      await count("channel_contexts", "channel_id = $1", [channelId]),
    ).toBe(2);
    expect(conversationScopeKey(here)).not.toBe(conversationScopeKey(there));
  });

  test("a key naming another workspace than the agent's is refused", async () => {
    await violates(
      store.findOrCreateConversation({
        kind: "channel",
        workspaceId: otherWorkspaceId,
        agentId,
        teamId: "T01",
        channelId: nextChannel(),
      }),
      "conversations_agent_fk",
    );
  });

  test("a DM with a person outside the workspace is refused", async () => {
    await violates(
      store.findOrCreateConversation({
        kind: "dm",
        workspaceId,
        agentId,
        personUserId: outsider,
      }),
      "conversations_person_fk",
    );
  });

  test("a row mixing a channel's and a DM's columns fails the place check", async () => {
    const channelId = nextChannel();
    await store.findOrCreateConversation({
      kind: "channel",
      workspaceId,
      agentId,
      teamId: "T01",
      channelId,
    });
    const insert = (
      kind: string,
      team: string | null,
      channel: string | null,
      person: string | null,
    ) =>
      pool.query(
        "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id, person_user_id) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [randomUUID(), workspaceId, secondAgentId, kind, team, channel, person],
      );
    for (const row of [
      ["channel", "T01", channelId, member],
      ["dm", "T01", channelId, member],
      ["dm", null, null, null],
      ["channel", "T01", null, null],
    ] as const) {
      await expect(insert(row[0], row[1], row[2], row[3])).rejects.toThrow(
        /conversations_place_check/,
      );
    }
    await expect(insert("group", "T01", channelId, null)).rejects.toThrow(
      /conversations_kind_check/,
    );
  });

  test("a channel id that could split a scope key is refused", async () => {
    await expect(
      pool.query(
        "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, 'T01', 'C1:X')",
        [randomUUID(), workspaceId],
      ),
    ).rejects.toThrow(/channel_contexts_ids_check/);
  });

  describe("topics", () => {
    const channelConversation = async (channelId: string) =>
      store.findOrCreateConversation({
        kind: "channel",
        workspaceId,
        agentId,
        teamId: "T01",
        channelId,
      });

    test("two racing find-or-creates of one thread leave one topic", async () => {
      const channelId = nextChannel();
      const conversation = await channelConversation(channelId);
      const thread = {
        teamId: "T01",
        channelId,
        threadTs: "1700000000.000100",
      };
      const [a, b] = await Promise.all([
        store.findOrCreateThreadTopic(conversation.id, thread),
        store.findOrCreateThreadTopic(conversation.id, thread),
      ]);
      expect(a.id).toBe(b.id);
      expect(a.thread).toEqual(thread);
      expect(
        await count("conversation_topics", "conversation_id = $1", [
          conversation.id,
        ]),
      ).toBe(1);
    });

    test("another thread of the channel is another topic", async () => {
      const channelId = nextChannel();
      const conversation = await channelConversation(channelId);
      const a = await store.findOrCreateThreadTopic(conversation.id, {
        teamId: "T01",
        channelId,
        threadTs: "1700000000.000100",
      });
      const b = await store.findOrCreateThreadTopic(conversation.id, {
        teamId: "T01",
        channelId,
        threadTs: "1700000000.000200",
      });
      expect(a.id).not.toBe(b.id);
    });

    test("a channel conversation refuses a thread of another channel", async () => {
      const conversation = await channelConversation(nextChannel());
      await expect(
        store.findOrCreateThreadTopic(conversation.id, {
          teamId: "T01",
          channelId: nextChannel(),
          threadTs: "1700000000.000100",
        }),
      ).rejects.toThrow(/is not in the channel/);
      await expect(
        store.findOrCreateThreadTopic(randomUUID() as ConversationId, {
          teamId: "T01",
          channelId: "C1",
          threadTs: "1700000000.000100",
        }),
      ).rejects.toThrow(/does not exist/);
    });

    test("each agent in a thread has its own topic", async () => {
      const channelId = nextChannel();
      const thread = {
        teamId: "T01",
        channelId,
        threadTs: "1700000000.000100",
      };
      const mine = await store.findOrCreateThreadTopic(
        (await channelConversation(channelId)).id,
        thread,
      );
      const theirs = await store.findOrCreateThreadTopic(
        (
          await store.findOrCreateConversation({
            kind: "channel",
            workspaceId,
            agentId: secondAgentId,
            teamId: "T01",
            channelId,
          })
        ).id,
        thread,
      );
      expect(mine.id).not.toBe(theirs.id);
    });

    test("a DM topic keeps its D… channel; a thread already another conversation's is refused", async () => {
      const dm = await store.findOrCreateConversation({
        kind: "dm",
        workspaceId,
        agentId,
        personUserId: member,
      });
      const thread = {
        teamId: "T01",
        channelId: "D0001",
        threadTs: "1700000000.000300",
      };
      const topic = await store.findOrCreateThreadTopic(dm.id, thread);
      expect(topic.thread).toEqual(thread);
      const other = await store.findOrCreateConversation({
        kind: "dm",
        workspaceId,
        agentId,
        personUserId: await pool
          .query(
            "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u') RETURNING id",
            [randomUUID(), `${randomUUID()}@example.invalid`],
          )
          .then(async ({ rows }) => {
            await pool.query(
              "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
              [workspaceId, rows[0]?.id],
            );
            return rows[0]?.id as string;
          }),
      });
      await expect(
        store.findOrCreateThreadTopic(other.id, thread),
      ).rejects.toThrow(/is a topic of conversation/);
    });

    test("a web topic has no alias until Slack places it; a partial alias is refused", async () => {
      const conversation = await channelConversation(nextChannel());
      const insert = (
        team: string | null,
        channel: string | null,
        ts: string | null,
      ) =>
        pool.query(
          "INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id, conversation_kind, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ($1, $2, $3, $4, 'channel', $5, $6, $7)",
          [
            randomUUID(),
            workspaceId,
            agentId,
            conversation.id,
            team,
            channel,
            ts,
          ],
        );
      await insert(null, null, null);
      await insert(null, null, null);
      expect(
        await count("conversation_topics", "conversation_id = $1", [
          conversation.id,
        ]),
      ).toBe(2);
      for (const row of [
        ["T01", null, null],
        [null, "C1", "1700000000.000100"],
        ["T01", "C1", "not-a-ts"],
      ] as const) {
        await expect(insert(row[0], row[1], row[2])).rejects.toThrow(
          /conversation_topics_slack_check/,
        );
      }
    });

    test("a topic cannot sit under another agent's conversation", async () => {
      const conversation = await channelConversation(nextChannel());
      await expect(
        pool.query(
          "INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id, conversation_kind) VALUES ($1, $2, $3, $4, 'channel')",
          [randomUUID(), workspaceId, secondAgentId, conversation.id],
        ),
      ).rejects.toThrow(/conversation_topics_conversation_fk/);
    });

    test("a written topic cannot leave its channel or claim another kind", async () => {
      // The store refuses these too; the database must, for any other writer.
      const channelId = nextChannel();
      const conversation = await channelConversation(channelId);
      const insert = (kind: string, channel: string) =>
        pool.query(
          "INSERT INTO conversation_topics (id, workspace_id, agent_id, conversation_id, conversation_kind, slack_team_id, slack_channel_id, slack_thread_ts) VALUES ($1, $2, $3, $4, $5, 'T01', $6, '1700000000.000900')",
          [randomUUID(), workspaceId, agentId, conversation.id, kind, channel],
        );
      await expect(insert("channel", "C99")).rejects.toThrow(
        /conversation_topics_channel_fk/,
      );
      await expect(insert("dm", "C99")).rejects.toThrow(
        /conversation_topics_conversation_fk/,
      );
      await insert("channel", channelId);
      await expect(
        pool.query(
          "UPDATE conversation_topics SET slack_channel_id = 'C99' WHERE conversation_id = $1",
          [conversation.id],
        ),
      ).rejects.toThrow(/conversation_topics_channel_fk/);
    });

    test("ids in upper case find the same rows", async () => {
      const channelId = nextChannel();
      const lower = await store.findOrCreateConversation({
        kind: "channel",
        workspaceId,
        agentId,
        teamId: "T01",
        channelId,
      });
      const upper = await store.findOrCreateConversation({
        kind: "channel",
        workspaceId: workspaceId.toUpperCase(),
        agentId: agentId.toUpperCase(),
        teamId: "T01",
        channelId,
      });
      expect(upper.id).toBe(lower.id);
      const thread = {
        teamId: "T01",
        channelId,
        threadTs: "1700000000.000100",
      };
      const a = await store.findOrCreateThreadTopic(lower.id, thread);
      const b = await store.findOrCreateThreadTopic(
        lower.id.toUpperCase() as ConversationId,
        thread,
      );
      expect(b.id).toBe(a.id);
      const dm = await store.findOrCreateConversation({
        kind: "dm",
        workspaceId: workspaceId.toUpperCase(),
        agentId: secondAgentId.toUpperCase(),
        personUserId: member.toUpperCase(),
      });
      expect(dm).toMatchObject({
        agentId: secondAgentId,
        personUserId: member,
      });
    });
  });
});
