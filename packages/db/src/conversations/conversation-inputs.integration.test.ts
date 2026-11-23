import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import {
  type ClientMessageId,
  type ConversationId,
  type ConversationTopicId,
  clientMessageIdSchema,
} from "@werft-ai/contracts";
import type {
  ConversationInputStore,
  TakeWebInputRequest,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { createPostgresSlackInboundEventStore } from "../surface/slack-inbound-events.ts";
import { fixtureTeamSql } from "../testing/fixture-team.ts";
import { waitsOn } from "../testing/lock-wait.ts";
import { newPartitionedSession } from "../testing/sessions.ts";
import { createPostgresConversationInputStore } from "./conversation-inputs.ts";
import { createPostgresConversationStore } from "./conversation-store.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("web inputs in conversation_inputs (0319)", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let inputs: ConversationInputStore;
  const workspaceId = randomUUID();
  const agentId = randomUUID();
  const member = randomUUID();
  const otherMember = randomUUID();
  const disabled = randomUUID();
  const suspended = randomUUID();
  // Linked to Slack in teamId; the others have no live link.
  const linked = randomUUID();
  const teamId = "T0WEB";

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "web_inputs" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    inputs = createPostgresConversationInputStore(db);
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [workspaceId, `ws-${workspaceId.slice(0, 8)}`],
    );
    for (const id of [member, otherMember, disabled, suspended, linked]) {
      await pool.query(
        "INSERT INTO users (id, email, display_name, disabled_at) VALUES ($1, $2, 'u', $3)",
        [id, `${id}@example.invalid`, id === suspended ? new Date() : null],
      );
      await pool.query(
        "INSERT INTO memberships (workspace_id, user_id, role, disabled_at) VALUES ($1, $2, 'member', $3)",
        [workspaceId, id, id === disabled ? new Date() : null],
      );
    }
    await linkSlack(linked, teamId);
    const team = await fixtureTeamSql(pool, workspaceId);
    await pool.query(
      "INSERT INTO agents (id, workspace_id, managing_team_id, slug, name, status) VALUES ($1, $2, $3, $4, 'agent', 'active')",
      [agentId, workspaceId, team, `agent-${agentId.slice(0, 8)}`],
    );
  }, 120_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  }, 60_000);

  const key = (): ClientMessageId => clientMessageIdSchema.parse(randomUUID());

  async function dm(person: string): Promise<ConversationId> {
    const conversation = await createPostgresConversationStore(
      db,
    ).findOrCreateConversation({
      kind: "dm",
      workspaceId,
      agentId,
      personUserId: person,
    });
    return conversation.id;
  }

  const request = (
    overrides: Partial<TakeWebInputRequest> &
      Pick<TakeWebInputRequest, "conversationId">,
  ): TakeWebInputRequest => ({
    workspaceId,
    agentId,
    requesterUserId: member,
    topicId: null,
    clientMessageId: key(),
    body: "build the report",
    ...overrides,
  });

  async function inputRows(where: string, values: unknown[]) {
    const { rows } = await pool.query(
      `SELECT * FROM conversation_inputs WHERE ${where} ORDER BY seq`,
      values,
    );
    return rows;
  }

  test("a new web topic gets a topic row with no Slack alias, and the input keeps its text", async () => {
    const conversationId = await dm(member);
    const taken = await inputs.takeWebInput(
      request({ conversationId, body: "  build the report\n" }),
    );
    if (taken.outcome !== "taken") throw new Error(taken.outcome);
    expect(taken.receipt).toMatchObject({
      seq: 1,
      requester: { kind: "user", id: member },
      slackMirror: "not_target",
    });
    const { rows: topics } = await pool.query(
      "SELECT * FROM conversation_topics WHERE id = $1",
      [taken.receipt.topicId],
    );
    expect(topics).toHaveLength(1);
    expect(topics[0]).toMatchObject({
      conversation_id: conversationId,
      conversation_kind: "dm",
      slack_team_id: null,
      slack_channel_id: null,
      slack_thread_ts: null,
    });
    const [row] = await inputRows("id = $1", [taken.receipt.inputId]);
    expect(row).toMatchObject({
      body: "  build the report\n",
      slack_mirror: "not_target",
      requester_kind: "user",
      requester_id: member,
      turn_id: null,
      slack_ts: null,
    });
  });

  test("a retry with the same key and text gets the same input id and number back", async () => {
    const conversationId = await dm(member);
    const first = request({ conversationId });
    const taken = await inputs.takeWebInput(first);
    const again = await inputs.takeWebInput(first);
    if (taken.outcome !== "taken") throw new Error(taken.outcome);
    expect(again).toEqual({ outcome: "replayed", receipt: taken.receipt });
    expect(
      await inputRows("client_message_id = $1", [first.clientMessageId]),
    ).toHaveLength(1);
  });

  test("the same key with other text is a mismatch, byte for byte", async () => {
    const conversationId = await dm(member);
    const first = request({ conversationId, body: "deploy" });
    await inputs.takeWebInput(first);
    for (const body of ["deploy ", "Deploy", "deploy\n"]) {
      expect(await inputs.takeWebInput({ ...first, body })).toEqual({
        outcome: "body_mismatch",
      });
    }
    const rows = await inputRows("client_message_id = $1", [
      first.clientMessageId,
    ]);
    expect(rows.map((row) => row.body)).toEqual(["deploy"]);
  });

  test("two retries racing leave one row and one topic", async () => {
    for (let round = 0; round < 5; round += 1) {
      const conversationId = await dm(member);
      const topics = () =>
        pool
          .query(
            "SELECT count(*)::int AS n FROM conversation_topics WHERE conversation_id = $1",
            [conversationId],
          )
          .then(({ rows }) => rows[0]?.n as number);
      const before = await topics();
      const same = request({ conversationId });
      const [a, b] = await Promise.all([
        inputs.takeWebInput(same),
        inputs.takeWebInput(same),
      ]);
      expect([a.outcome, b.outcome].sort()).toEqual(["replayed", "taken"]);
      if (a.outcome === "body_mismatch" || b.outcome === "body_mismatch") {
        throw new Error("mismatch");
      }
      if (!("receipt" in a) || !("receipt" in b)) throw new Error("no receipt");
      expect(a.receipt).toEqual(b.receipt);
      expect(
        await inputRows("client_message_id = $1", [same.clientMessageId]),
      ).toHaveLength(1);
      expect(await topics()).toBe(before + 1);
    }
  });

  test("another person's same key is another row", async () => {
    const clientMessageId = key();
    const mine = await inputs.takeWebInput(
      request({ conversationId: await dm(member), clientMessageId }),
    );
    const theirs = await inputs.takeWebInput(
      request({
        conversationId: await dm(otherMember),
        requesterUserId: otherMember,
        clientMessageId,
        body: "something else",
      }),
    );
    if (mine.outcome !== "taken" || theirs.outcome !== "taken") {
      throw new Error(`${mine.outcome} ${theirs.outcome}`);
    }
    expect(theirs.receipt.inputId).not.toBe(mine.receipt.inputId);
    expect(theirs.receipt.requester.id).toBe(otherMember);
    expect(
      await inputRows("client_message_id = $1", [clientMessageId]),
    ).toHaveLength(2);
  });

  test("web and Slack inputs alternating in one topic are numbered in the order taken", async () => {
    const conversations = createPostgresConversationStore(db);
    const channelId = `C${randomBytes(4).toString("hex").toUpperCase()}`;
    const conversation = await conversations.findOrCreateConversation({
      kind: "channel",
      workspaceId,
      agentId,
      teamId,
      channelId,
    });
    const topic = await conversations.findOrCreateThreadTopic(conversation.id, {
      teamId,
      channelId,
      threadTs: "1700000000.000100",
    });
    const app = await slackApp();
    const web = async () => {
      const taken = await inputs.takeWebInput(
        request({
          conversationId: conversation.id,
          topicId: topic.id,
          requesterUserId: linked,
        }),
      );
      if (taken.outcome !== "taken") throw new Error(taken.outcome);
    };
    // Slack's ts runs backwards here: the number follows receipt, not ts.
    await slackInput(app, topic.id, channelId, "1700000000.000900");
    await web();
    await slackInput(app, topic.id, channelId, "1700000000.000500");
    await web();
    const rows = await inputRows("topic_id = $1", [topic.id]);
    expect(
      rows.map((row) => [
        row.seq,
        row.client_message_id === null ? "slack" : "web",
        row.slack_ts,
      ]),
    ).toEqual([
      [1, "slack", "1700000000.000900"],
      [2, "web", null],
      [3, "slack", "1700000000.000500"],
      [4, "web", null],
    ]);
  });

  test("a web input names an existing topic only inside its own conversation", async () => {
    const mine = await inputs.takeWebInput(
      request({ conversationId: await dm(member) }),
    );
    if (mine.outcome !== "taken") throw new Error(mine.outcome);
    expect(
      await inputs.takeWebInput(
        request({
          conversationId: await dm(otherMember),
          requesterUserId: otherMember,
          topicId: mine.receipt.topicId,
        }),
      ),
    ).toEqual({ outcome: "topic_not_found" });
    expect(
      await inputs.takeWebInput(
        request({
          conversationId: await dm(member),
          topicId: randomUUID() as ConversationTopicId,
        }),
      ),
    ).toEqual({ outcome: "topic_not_found" });
  });

  test("a disabled membership or a suspended account is not taken", async () => {
    expect(await inputs.isMember(workspaceId, member)).toBe(true);
    for (const person of [disabled, suspended]) {
      expect(await inputs.isMember(workspaceId, person)).toBe(false);
      expect(
        await inputs.takeWebInput(
          request({
            conversationId: await dm(member),
            requesterUserId: person,
          }),
        ),
      ).toEqual({ outcome: "not_member" });
    }
  });

  test("a suspension racing receipts neither deadlocks nor lets an input in after it", async () => {
    for (let round = 0; round < 5; round += 1) {
      const person = randomUUID();
      await pool.query(
        "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
        [person, `${person}@example.invalid`],
      );
      await pool.query(
        "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
        [workspaceId, person],
      );
      const conversationId = await dm(person);
      // As members.ts setAccess takes them: the user, then the membership.
      const suspend = async () => {
        const client = await pool.connect();
        try {
          await client.query("BEGIN");
          await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
            person,
          ]);
          await client.query(
            "SELECT 1 FROM memberships WHERE user_id = $1 FOR UPDATE",
            [person],
          );
          await client.query(
            "UPDATE users SET disabled_at = now() WHERE id = $1",
            [person],
          );
          await client.query("COMMIT");
          return new Date();
        } finally {
          client.release();
        }
      };
      const takes = Array.from({ length: 4 }, () =>
        inputs.takeWebInput(
          request({ requesterUserId: person, conversationId }),
        ),
      );
      const [suspendedAt, ...outcomes] = await Promise.all([
        suspend(),
        ...takes,
      ]);
      for (const taken of outcomes) {
        expect(["taken", "not_member"]).toContain(taken.outcome);
      }
      const late = await inputRows("requester_id = $1 AND received_at > $2", [
        person,
        suspendedAt,
      ]);
      expect(late).toHaveLength(0);
      expect(
        await inputs.takeWebInput(
          request({ requesterUserId: person, conversationId }),
        ),
      ).toEqual({ outcome: "not_member" });
    }
  });

  test("a receipt that waited on a suspension finds the account suspended", async () => {
    const person = randomUUID();
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
      [person, `${person}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [workspaceId, person],
    );
    const conversationId = await dm(person);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
      await client.query("SELECT 1 FROM users WHERE id = $1 FOR UPDATE", [
        person,
      ]);
      await client.query("UPDATE users SET disabled_at = now() WHERE id = $1", [
        person,
      ]);
      let settled = false;
      const taking = inputs
        .takeWebInput(request({ requesterUserId: person, conversationId }))
        .finally(() => {
          settled = true;
        });
      expect(await waitsOn(db, rows[0].pid, () => settled)).toBe(true);
      await client.query("COMMIT");
      expect(await taking).toEqual({ outcome: "not_member" });
    } finally {
      client.release();
    }
    expect(await inputRows("requester_id = $1", [person])).toHaveLength(0);
  });

  test("the person's live Slack links decide: a DM is mirrored or not, a channel input needs its team", async () => {
    const conversations = createPostgresConversationStore(db);
    const channel = (team: string) =>
      conversations.findOrCreateConversation({
        kind: "channel",
        workspaceId,
        agentId,
        teamId: team,
        channelId: `C${randomBytes(4).toString("hex").toUpperCase()}`,
      });
    // Before: no link, so a DM is no mirror target and a channel is refused.
    const person = randomUUID();
    await pool.query(
      "INSERT INTO users (id, email, display_name) VALUES ($1, $2, 'u')",
      [person, `${person}@example.invalid`],
    );
    await pool.query(
      "INSERT INTO memberships (workspace_id, user_id, role) VALUES ($1, $2, 'member')",
      [workspaceId, person],
    );
    const as = { requesterUserId: person };
    expect(
      await inputs.takeWebInput(
        request({ ...as, conversationId: await dm(person) }),
      ),
    ).toMatchObject({
      outcome: "taken",
      receipt: { slackMirror: "not_target" },
    });
    const inTeam = await channel(teamId);
    expect(
      await inputs.takeWebInput(request({ ...as, conversationId: inTeam.id })),
    ).toEqual({ outcome: "unlinked" });
    // A link in another team, or one gone stale, does not open this channel.
    const linkId = await linkSlack(person, "T0OTHER");
    expect(
      await inputs.takeWebInput(request({ ...as, conversationId: inTeam.id })),
    ).toEqual({ outcome: "unlinked" });
    // After: a DM waits for Slack, and the other team's channel takes it.
    expect(
      await inputs.takeWebInput(
        request({ ...as, conversationId: await dm(person) }),
      ),
    ).toMatchObject({ receipt: { slackMirror: "pending" } });
    const other = await channel("T0OTHER");
    const posted = request({ ...as, conversationId: other.id });
    const first = await inputs.takeWebInput(posted);
    if (first.outcome !== "taken") throw new Error(first.outcome);
    expect(first.receipt.slackMirror).toBe("pending");
    // A retry after the unlink still gets its receipt; a new input does not.
    await pool.query(
      "UPDATE linked_accounts SET status = 'revoked', revoked_reason = 'unlinked', revoked_at = now() WHERE id = $1",
      [linkId],
    );
    expect(await inputs.takeWebInput(posted)).toEqual({
      outcome: "replayed",
      receipt: first.receipt,
    });
    expect(
      await inputs.takeWebInput({ ...posted, body: "other text" }),
    ).toEqual({ outcome: "body_mismatch" });
    expect(
      await inputs.takeWebInput(request({ ...as, conversationId: other.id })),
    ).toEqual({ outcome: "unlinked" });
    expect(
      await inputRows(
        "slack_mirror = 'not_target' AND topic_id IN (SELECT id FROM conversation_topics WHERE conversation_kind = 'channel')",
        [],
      ),
    ).toHaveLength(0);
  });

  test("web inputs and a Slack input racing in one topic take distinct numbers", async () => {
    const conversations = createPostgresConversationStore(db);
    const channelId = `C${randomBytes(4).toString("hex").toUpperCase()}`;
    const conversation = await conversations.findOrCreateConversation({
      kind: "channel",
      workspaceId,
      agentId,
      teamId,
      channelId,
    });
    const topic = await conversations.findOrCreateThreadTopic(conversation.id, {
      teamId,
      channelId,
      threadTs: "1700000001.000100",
    });
    const app = await slackApp();
    const outcomes = await Promise.all([
      slackInput(app, topic.id, channelId, "1700000001.000200"),
      ...Array.from({ length: 6 }, () =>
        inputs
          .takeWebInput(
            request({
              conversationId: conversation.id,
              topicId: topic.id,
              requesterUserId: linked,
            }),
          )
          .then((taken) => taken.outcome),
      ),
    ]);
    expect(outcomes.slice(1)).toEqual(Array(6).fill("taken"));
    const rows = await inputRows("topic_id = $1", [topic.id]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  test("the table refuses a web row missing its fields and a Slack row with no turn", async () => {
    const taken = await inputs.takeWebInput(
      request({ conversationId: await dm(member) }),
    );
    if (taken.outcome !== "taken") throw new Error(taken.outcome);
    const insert = (columns: string, values: string) =>
      pool
        .query(
          `INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq, requester_kind, requester_id${columns}) VALUES ($1, $2, $3, $4, 99, 'user', $5${values})`,
          [randomUUID(), workspaceId, agentId, taken.receipt.topicId, member],
        )
        .then(
          () => null,
          (error: { constraint?: string }) => error.constraint,
        );
    const check = "conversation_inputs_origin_check";
    // A Slack-shaped row with no turn.
    expect(await insert("", "")).toBe(check);
    expect(
      await insert(", client_message_id, slack_mirror", ", 'k1', 'pending'"),
    ).toBe(check);
    expect(await insert(", client_message_id, body", ", 'k2', 'b'")).toBe(
      check,
    );
    expect(
      await insert(
        ", client_message_id, body, slack_mirror",
        ", 'bad key!', 'b', 'pending'",
      ),
    ).toBe(check);
    expect(
      await insert(
        ", client_message_id, body, slack_mirror",
        ", 'k3', 'b', 'placed'",
      ),
    ).toBe(check);
    expect(
      await pool
        .query(
          "INSERT INTO conversation_inputs (id, workspace_id, agent_id, topic_id, seq, requester_kind, requester_id, client_message_id, body, slack_mirror) VALUES ($1, $2, $3, $4, 98, 'slack_bot', 'U0BOT', 'k4', 'b', 'pending')",
          [randomUUID(), workspaceId, agentId, taken.receipt.topicId],
        )
        .then(
          () => null,
          (error: { constraint?: string }) => error.constraint,
        ),
    ).toBe(check);
  });

  async function linkSlack(userId: string, team: string): Promise<string> {
    const id = randomUUID();
    await pool.query(
      "INSERT INTO linked_accounts (id, workspace_id, user_id, provider, external_tenant, external_user_id, verified_via, verified_at) VALUES ($1, $2, $3, 'slack', $4, $5, 'slack_oidc', now())",
      [
        id,
        workspaceId,
        userId,
        team,
        `U${randomBytes(4).toString("hex").toUpperCase()}`,
      ],
    );
    return id;
  }

  // One live app per agent, made by the first test that needs it.
  let app: Promise<{ slackAppId: string; appId: string }> | undefined;
  function slackApp() {
    app ??= makeSlackApp();
    return app;
  }

  async function makeSlackApp() {
    const slackAppId = randomUUID();
    const appId = `A${randomBytes(4).toString("hex").toUpperCase()}`;
    await pool.query(
      "INSERT INTO slack_apps (id, workspace_id, kind, agent_id, state, app_id, client_id, redirect_url) VALUES ($1, $2, 'agent', $3, 'created', $4, '1.1', 'https://console.example/cb')",
      [slackAppId, workspaceId, agentId, appId],
    );
    return { slackAppId, appId };
  }

  // A Slack message the handler made a turn of, taken through the inbox's
  // completion as the slack role takes it.
  async function slackInput(
    app: { slackAppId: string; appId: string },
    topicId: ConversationTopicId,
    channelId: string,
    ts: string,
  ) {
    const session = await newPartitionedSession(db, "web-inputs");
    await pool.query("UPDATE sessions SET workspace_id = $1 WHERE id = $2", [
      workspaceId,
      session.sessionId,
    ]);
    await pool.query(
      "UPDATE turns SET requester_kind = 'user', requester_id = $1 WHERE session_id = $2",
      [otherMember, session.sessionId],
    );
    const inbox = createPostgresSlackInboundEventStore(db);
    const eventId = `Ev${randomBytes(4).toString("hex")}`;
    await inbox.record({
      workspaceId,
      agentId,
      slackAppId: app.slackAppId,
      teamId,
      appId: app.appId,
      eventId,
      eventType: "app_mention",
      eventSubtype: null,
      eventTime: new Date(),
      status: "received",
      payload: { type: "event_callback", event_id: eventId },
      conversationKey: null,
    });
    const [claim] = await inbox.claim({
      limit: 1,
      leaseMs: 60_000,
      maxAttempts: 5,
    });
    if (claim === undefined) throw new Error("nothing to claim");
    expect(
      await inbox.complete(claim, {
        topicId,
        channelId,
        ts,
        turn: { sessionId: session.sessionId, sequence: 1 },
      }),
    ).toBe(true);
  }
});
