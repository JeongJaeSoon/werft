import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  type AgentRelease,
  agentCardRequestSchema,
  conversationCallKeySchema,
  conversationIdSchema,
  scopesForRole,
} from "@werft-ai/contracts";
import {
  type AgentService,
  type Caller,
  callerFor,
  createAgentService,
  createAuthorizationPolicy,
  createConversationCalls,
  judgmentCallOf,
  type SessionCatalog,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentStore } from "./agents.ts";
import { createPostgresConversationCalls } from "./conversation-calls.ts";
import { createPostgresCredentialBindingStore } from "./musterrolle/credential-bindings.ts";
import { createDatabaseIdentityReader } from "./musterrolle/identity-reader.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  conversationCalls,
  memberships,
  memberTeams,
  users,
  workspaces,
} from "./schema.ts";
import {
  TEST_CONNECTION_ID,
  TEST_RUNTIMES,
  testSessionCatalog,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const PROVIDER = {
  kind: "anthropic" as const,
  endpoint: "https://api.anthropic.invalid",
  auth: {
    kind: "api_key" as const,
    value: "catalog-provider-key",
    ref: { stored: "connection:test-connection" },
  },
};
const CARD_MODEL = "claude-opus-5-1";
const SMALL = "claude-haiku-5-0";
const OTHER_SMALL = "claude-haiku-5-1";
const ALL = [CARD_MODEL, SMALL, OTHER_SMALL];

const catalogOf = (models: string[]): SessionCatalog =>
  testSessionCatalog({
    provider: PROVIDER,
    models,
    repositories: {
      app: {
        url: "https://example.invalid/app.git",
        branch: "main",
        auth: { kind: "github_app", registered: true },
      },
    },
  });
const NO_CONNECTION = {
  connections: {},
} as unknown as Pick<SessionCatalog, "connections">;

function card(judgment?: string) {
  return agentCardRequestSchema.parse({
    model: CARD_MODEL,
    ...(judgment === undefined ? {} : { judgment_model: judgment }),
    capabilities: { mcp: null, forbidden: [] },
  });
}

// What the workspace's achievement judge runs on, the decision model this
// field is kept apart from.
const JUDGE_SETTINGS = {
  achievement_judge: { connection_id: "openai-decisions", threshold: 0.8 },
};

integration("an agent's judgment model on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let owner: Caller;
  let teamId: string;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "judgment_model_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    owner = await personOf("owner");
    teamId = randomUUID();
    await db.insert(memberTeams).values({
      id: teamId,
      workspaceId: owner.ownerId,
      name: "team",
    });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  let workspaceId: string | undefined;
  async function personOf(role: "owner" | "member"): Promise<Caller> {
    if (workspaceId === undefined) {
      workspaceId = randomUUID();
      const slug = `ws-${workspaceId.slice(0, 8)}`;
      await db.insert(workspaces).values({
        id: workspaceId,
        slug,
        name: slug,
        settings: JUDGE_SETTINGS,
      });
    }
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: "web" },
      randomUUID(),
    );
  }

  const service = (): AgentService =>
    createAgentService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresAgentStore(db),
      catalog: catalogOf(ALL),
      credentials: createPostgresCredentialBindingStore(db),
      runtimes: TEST_RUNTIMES,
    });

  async function conversationOf(agentId: string) {
    const conversationId = conversationIdSchema.parse(randomUUID());
    const channel = `C${randomUUID().slice(0, 8).toUpperCase()}`;
    await pool.query(
      "INSERT INTO channel_contexts (id, workspace_id, team_id, channel_id) VALUES ($1, $2, 'T0JUDGE', $3)",
      [randomUUID(), owner.ownerId, channel],
    );
    await pool.query(
      "INSERT INTO conversations (id, workspace_id, agent_id, kind, team_id, channel_id) VALUES ($1, $2, $3, 'channel', 'T0JUDGE', $4)",
      [conversationId, owner.ownerId, agentId, channel],
    );
    return conversationId;
  }

  // One judgment call as the M1 judge places it: on the agent's active
  // release, charged to the agent's team.
  async function judge(
    agentId: string,
    conversationId: ReturnType<typeof conversationIdSchema.parse>,
    catalog: Pick<SessionCatalog, "connections">,
  ) {
    const agent = await createPostgresAgentStore(db).get(
      owner.ownerId,
      agentId,
    );
    const release = agent?.active_release as AgentRelease;
    const call = judgmentCallOf(catalog, release);
    if (call.outcome !== "ready") return call;
    return createConversationCalls({
      store: createPostgresConversationCalls(db as unknown as Database),
      catalog,
    }).issue({
      workspaceId: owner.ownerId,
      agentId,
      conversationId,
      topicId: null,
      callClass: "m1",
      releaseId: call.releaseId,
      callKey: conversationCallKeySchema.parse(`${randomUUID()}:m1`),
      attempt: 1,
      root: { kind: "key", keyKind: "agent", createdByUserId: null },
      connectionId: call.connectionId,
      model: call.model,
      maxTokens: 256,
      maxRequestBytes: 4_096,
    });
  }

  const ledgerOf = async (callId: string) =>
    (
      await db
        .select({
          releaseId: conversationCalls.releaseId,
          model: conversationCalls.model,
        })
        .from(conversationCalls)
        .where(eq(conversationCalls.id, callId as never))
    )[0];
  const callCount = async (agentId: string) =>
    (
      await db
        .select({ id: conversationCalls.id })
        .from(conversationCalls)
        .where(eq(conversationCalls.agentId, agentId))
    ).length;

  test("a new release changes the next call's model, and the ledger names the new release", async () => {
    const made = await service().createAgent(owner, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "judge",
      managing_team_id: teamId,
      card: card(SMALL),
      connection_id: TEST_CONNECTION_ID,
    });
    const agentId = made.agent.id;
    const first = made.agent.active_release_id as string;
    const conversationId = await conversationOf(agentId);

    const one = await judge(agentId, conversationId, catalogOf(ALL));
    if (one.outcome !== "issued") throw new Error(one.outcome);
    expect(await ledgerOf(one.callId)).toEqual({
      releaseId: first,
      model: SMALL,
    });

    const moved = await service().updateAgent(owner, agentId, {
      card: card(OTHER_SMALL),
    });
    expect(moved.release.status).toBe("applied");
    const second = moved.agent.active_release_id as string;
    expect(second).not.toBe(first);
    const two = await judge(agentId, conversationId, catalogOf(ALL));
    if (two.outcome !== "issued") throw new Error(two.outcome);
    expect(await ledgerOf(two.callId)).toEqual({
      releaseId: second,
      model: OTHER_SMALL,
    });

    // Cleared, the card's own model runs.
    const cleared = await service().updateAgent(owner, agentId, {
      card: card(),
    });
    const three = await judge(agentId, conversationId, catalogOf(ALL));
    if (three.outcome !== "issued") throw new Error(three.outcome);
    expect(await ledgerOf(three.callId)).toEqual({
      releaseId: cleared.agent.active_release_id,
      model: CARD_MODEL,
    });
  });

  test("a judgment model off the list or a connection gone issues nothing and says why", async () => {
    const made = await service().createAgent(owner, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "judge",
      managing_team_id: teamId,
      card: card(SMALL),
      connection_id: TEST_CONNECTION_ID,
    });
    const agentId = made.agent.id;
    const conversationId = await conversationOf(agentId);

    expect(
      await judge(agentId, conversationId, catalogOf([CARD_MODEL])),
    ).toEqual({ outcome: "unavailable", reason: "model_removed" });
    expect(await judge(agentId, conversationId, NO_CONNECTION)).toEqual({
      outcome: "unavailable",
      reason: "connection_missing",
    });
    expect(await callCount(agentId)).toBe(0);
  });

  test("a save naming a model the connection lacks makes no release", async () => {
    const made = await service().createAgent(owner, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "judge",
      managing_team_id: teamId,
      card: card(SMALL),
      connection_id: TEST_CONNECTION_ID,
    });
    const refused = await service().updateAgent(owner, made.agent.id, {
      card: card("claude-haiku-0"),
    });
    expect(refused.release).toMatchObject({
      status: "failed",
      reason: "judgment_model_not_in_connection",
    });
    expect(refused.agent.active_release_id).toBe(made.agent.active_release_id);
  });

  test("a member outside the managing team is refused, and the workspace's decision model is left as it was", async () => {
    const made = await service().createAgent(owner, {
      slug: `agent-${randomUUID().slice(0, 8)}`,
      name: "judge",
      managing_team_id: teamId,
      card: card(),
      connection_id: TEST_CONNECTION_ID,
    });
    const member = await personOf("member");
    await expect(
      service().updateAgent(member, made.agent.id, { card: card(SMALL) }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await service().updateAgent(owner, made.agent.id, { card: card(SMALL) });
    const [row] = await db
      .select({ settings: workspaces.settings })
      .from(workspaces)
      .where(eq(workspaces.id, owner.ownerId));
    expect(row?.settings).toEqual(JUDGE_SETTINGS);
  });
});
