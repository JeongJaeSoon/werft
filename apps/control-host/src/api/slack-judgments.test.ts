import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { scopesForRole, type WorkspaceRole } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createDatabaseAgentAuthority,
  createDatabaseIdentityReader,
  createPostgresDecisionLog,
  createPostgresJudgmentReviewStore,
  memberships,
  users,
  workspaces,
} from "@werft-ai/db";
import { fixtureTeam } from "@werft-ai/db/testing/fixture-team";
import {
  type Caller,
  type ChannelMemberQuestion,
  callerFor,
  createAuthorizationPolicy,
  createJudgmentReviewService,
  SessionServiceError,
} from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";

const TEAM = "T0SHADOW";

describe("M1 shadow records over the real policy (a1/S3)", () => {
  let pool: PGlite;
  let db: schema.Database;
  let review: ReturnType<typeof createJudgmentReviewService>;
  const workspaceId = crypto.randomUUID();
  const agentId = crypto.randomUUID();
  const ids = {
    owner: crypto.randomUUID(),
    admin: crypto.randomUUID(),
    agentAdmin: crypto.randomUUID(),
    member: crypto.randomUUID(),
  };
  // Slack's answer per user: who is in the private channel now.
  const inPrivate = new Set<string>([ids.agentAdmin]);
  const asked: ChannelMemberQuestion[] = [];

  function user(who: keyof typeof ids, role: WorkspaceRole): Caller {
    return callerFor(
      {
        kind: "user",
        id: ids[who],
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      crypto.randomUUID(),
    );
  }

  async function judgment(
    channel: string,
    decision: "speak" | "quiet",
    reason: string,
    ts: string,
  ) {
    await pool.query(
      `INSERT INTO conversation_judgments (id, workspace_id, agent_id,
        conversation_id, grade, slack_team_id, slack_channel_id, refs,
        prompt_version, outcome, decision, reason, judged_at)
       VALUES ($1, $2, $3, $4, 'buffer_m1', $5, $6, $7, 1, 'judged', $8, $9,
        now() - interval '1 hour')`,
      [
        crypto.randomUUID(),
        workspaceId,
        agentId,
        await conversation(channel),
        TEAM,
        channel,
        [ts],
        decision,
        reason,
      ],
    );
  }

  const conversations = new Map<string, string>();
  async function conversation(channel: string) {
    const known = conversations.get(channel);
    if (known) return known;
    const id = crypto.randomUUID();
    await pool.query(
      "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [crypto.randomUUID(), workspaceId, TEAM, channel],
    );
    await pool.query(
      `INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id)
       VALUES ($1, $2, $3, 'channel', $4, $5)`,
      [id, workspaceId, agentId, TEAM, channel],
    );
    conversations.set(channel, id);
    return id;
  }

  beforeAll(async () => {
    pool = await migratedPGlite();
    db = drizzle(pool, { schema }) as unknown as schema.Database;
    review = createJudgmentReviewService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
        agents: createDatabaseAgentAuthority(db),
        decisions: createPostgresDecisionLog(db),
      }),
      store: createPostgresJudgmentReviewStore(db),
      members: {
        isMember: async (question) => {
          asked.push(question);
          return inPrivate.has(question.userId);
        },
      },
    });
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: "shadow", name: "Shadow" });
    for (const [who, id] of Object.entries(ids)) {
      await db.insert(users).values({
        id,
        email: `${who.toLowerCase()}@example.com`,
        displayName: who,
      });
      await db.insert(memberships).values({
        workspaceId,
        userId: id,
        role: who === "owner" ? "owner" : who === "admin" ? "admin" : "member",
      });
    }
    await db.insert(schema.agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: "listener",
      name: "Listener",
    });
    await db
      .insert(schema.agentAdmins)
      .values({ workspaceId, agentId, userId: ids.agentAdmin });
    const installationId = crypto.randomUUID();
    await pool.query(
      "INSERT INTO slack_installations (id, workspace_id, app_id, team_id) VALUES ($1, $2, 'A0SHADOW', $3)",
      [installationId, workspaceId, TEAM],
    );
    for (const [channel, kind] of [
      ["C0PUBLIC", "public_channel"],
      ["G0PRIVATE", "private_channel"],
    ] as const) {
      await pool.query(
        `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface,
          installation_id, external_surface_id, surface_kind, mode, listen,
          ceiling_actions, ceiling_disclosure, status)
         VALUES ($1, $2, $3, 'slack', $4, $5, $6, 'on', 'free', '{}', 'full',
          'ready')`,
        [
          crypto.randomUUID(),
          workspaceId,
          agentId,
          installationId,
          channel,
          kind,
        ],
      );
    }
    await judgment("C0PUBLIC", "speak", "needs_agent", "1764000000.000100");
    await judgment(
      "C0PUBLIC",
      "quiet",
      "human_conversation",
      "1764000000.000200",
    );
    await judgment(
      "C0PUBLIC",
      "quiet",
      "human_conversation",
      "1764000000.000300",
    );
    await judgment("G0PRIVATE", "quiet", "not_for_agent", "1764000000.000400");
    await judgment("G0PRIVATE", "speak", "needs_agent", "1764000000.000500");
  }, 120_000);

  afterAll(async () => {
    await pool?.close();
  });

  test("owner, admin and the agent's admin read it; a member is refused", async () => {
    for (const caller of [
      user("owner", "owner"),
      user("admin", "admin"),
      user("agentAdmin", "member"),
    ]) {
      const read = await review.getSlackJudgments(caller, agentId);
      expect(read.channels.length).toBeGreaterThan(0);
    }
    const refused = await review
      .getSlackJudgments(user("member", "member"), agentId)
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SessionServiceError);
    expect((refused as SessionServiceError).code).toBe("FORBIDDEN");
  });

  test("the counts are the ledger's rows, and the list holds links and codes only", async () => {
    const read = await review.getSlackJudgments(
      user("agentAdmin", "member"),
      agentId,
    );
    const sums = await pool.query<{
      channel: string;
      n: number;
      speak: number;
    }>(
      `SELECT slack_channel_id AS channel, count(*)::int AS n,
        (count(*) FILTER (WHERE decision = 'speak'))::int AS speak
       FROM conversation_judgments
       WHERE agent_id = $1 AND outcome IS NOT NULL
       GROUP BY 1 ORDER BY 1`,
      [agentId],
    );
    expect(
      read.channels
        .map((channel) => ({
          channel: channel.channel_id,
          n: channel.judgments,
          speak: channel.speak,
        }))
        .sort((a, b) => a.channel.localeCompare(b.channel)),
    ).toEqual(sums.rows);
    expect(read.recent).toHaveLength(5);
    for (const item of read.recent) {
      expect(Object.keys(item).sort()).toEqual([
        "channel_id",
        "decision",
        "grade",
        "id",
        "judged_at",
        "outcome",
        "reason",
        "slack_team_id",
        "ts",
        "url",
      ]);
      expect(item.url).toBe(
        `https://slack.com/archives/${item.channel_id}/p${item.ts.replace(".", "")}`,
      );
    }
  });

  test("a private channel is in neither the counts nor the list of an owner who is not its member", async () => {
    for (const [caller, sees] of [
      [user("owner", "owner"), false],
      [user("admin", "admin"), false],
      [user("agentAdmin", "member"), true],
    ] as const) {
      const read = await review.getSlackJudgments(caller, agentId);
      const channels = read.channels.map((channel) => channel.channel_id);
      expect(channels.includes("G0PRIVATE")).toBe(sees);
      expect(read.recent.some((item) => item.channel_id === "G0PRIVATE")).toBe(
        sees,
      );
      // Nothing of it mixes into what is left.
      expect(
        read.channels.reduce((sum, channel) => sum + channel.judgments, 0),
      ).toBe(sees ? 5 : 3);
    }
    expect(asked.every((question) => question.channelId === "G0PRIVATE")).toBe(
      true,
    );
  });
});
