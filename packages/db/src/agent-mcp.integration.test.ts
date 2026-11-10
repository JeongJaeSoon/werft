import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole } from "@werft-ai/contracts";
import {
  type Caller,
  callerFor,
  createAgentMcpService,
  createAuthorizationPolicy,
  type SessionCatalog,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresAgentGitHubStore } from "./agent-github.ts";
import { createPostgresAgentMcpStore } from "./agent-mcp.ts";
import { createDatabaseIdentityReader } from "./identity-reader.ts";
import { createPostgresMcpEgressStore } from "./mcp-egress.ts";
import { captureMcpStart } from "./mcp-settings.ts";
import * as schema from "./schema.ts";
import {
  agentMcpSettings,
  agentReleases,
  agents,
  agentVersions,
  credentialBindings,
  memberships,
  receipts,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import {
  releaseSpecColumns,
  sessionPinColumns,
  TEST_CONNECTION_ID,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const READ = "mcp__docs__read";
const SEARCH = "mcp__docs__search";

// Each test makes its own workspace; `setup` lists its slug here, so `docs`
// is open to the workspaces a test creates and to no other.
const DOCS_WORKSPACES: string[] = [];

const CATALOG = {
  connections: {},
  repositories: {},
  mcp_servers: {
    docs: {
      url: "https://docs.example.com/mcp",
      credential_ref: "docs-key",
      auth: { kind: "bearer", value: "x", ref: { value_env: "X" } },
      workspaces: DOCS_WORKSPACES,
    },
  },
} as unknown as SessionCatalog;

/** The error code and reason of a refused call, or "saved". */
async function refusal(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const failure = error as {
      code?: string;
      details?: { reason_code?: string } | null;
    };
    return `${failure.code}:${failure.details?.reason_code ?? ""}`;
  }
  return "saved";
}

integration("the agent MCP settings writer on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "agent_mcp_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const service = () =>
    createAgentMcpService({
      authorization: createAuthorizationPolicy({
        identity: createDatabaseIdentityReader(db),
      }),
      store: createPostgresAgentMcpStore(db),
      catalog: CATALOG,
    });

  async function person(workspaceId: string, role: "owner" | "member") {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: role,
    });
    await db.insert(memberships).values({ workspaceId, userId, role });
    return userId;
  }

  const callerOf = (
    workspaceId: string,
    userId: string,
    role: "owner" | "member",
    surface: "web" | "api" = "web",
  ): Caller =>
    callerFor(
      {
        kind: "user",
        id: userId,
        workspace_id: workspaceId,
        role,
        scopes: [...scopesForRole(role)],
      },
      { kind: surface },
      randomUUID(),
    );

  // An agent running a release whose card names `docs` and `docs-key`, with
  // the pins a release writes; raw, so the stored shape is the one under test.
  async function setup(options: { snapshot?: Record<string, unknown> } = {}) {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    DOCS_WORKSPACES.push(slug);
    const ownerId = await person(workspaceId, "owner");
    const memberId = await person(workspaceId, "member");
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
      managingTeamId: await fixtureTeam(db, workspaceId),
      slug: `a-${agentId.slice(0, 8)}`,
      name: "agent",
    });
    const versionId = randomUUID();
    await db.insert(agentVersions).values({
      id: versionId,
      agentId,
      versionNo: 1,
      card: {
        role: "r",
        instructions: "i",
        model: "m",
        capabilities: {
          tools: null,
          mcp: [{ server: "docs" }],
          forbidden: [],
          credential_refs: ["docs-key"],
        },
      },
      contentSha256: "0".repeat(64),
    });
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256: "0".repeat(64),
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      // A release is immutable once written, so a test names its snapshot here.
      runtimeConfigSnapshot: options.snapshot ?? {},
      effectiveTools: { tools: [], mcp: [READ] },
      policyPins: {
        tools: {
          default: { builtin: "allow", mcp: "ask" },
          per_tool: { [READ]: "allow", [SEARCH]: "allow", mcp__docs__x: "ask" },
        },
      },
    });
    await db
      .update(agents)
      .set({ activeReleaseId: releaseId, activationRevision: 0 })
      .where(eq(agents.id, agentId));
    return {
      workspaceId,
      agentId,
      releaseId,
      ownerId,
      owner: callerOf(workspaceId, ownerId, "owner"),
      member: callerOf(workspaceId, memberId, "member"),
      byKey: callerOf(workspaceId, ownerId, "owner", "api"),
    };
  }

  const settings = (over: Record<string, unknown> = {}) => ({
    server: "docs",
    allowed_tools: [READ, SEARCH],
    credential_refs: ["docs-key"],
    ...over,
  });
  const request = (
    expected_revision: number | null,
    over: Record<string, unknown> = {},
  ) => ({ expected_revision, settings: settings(over) });

  const rowOf = async (agentId: string) =>
    (
      await db
        .select()
        .from(agentMcpSettings)
        .where(eq(agentMcpSettings.agentId, agentId))
    )[0];

  const receiptsOf = (agentId: string) =>
    db
      .select()
      .from(receipts)
      .where(eq(receipts.operation, "set_agent_mcp"))
      .then((rows) =>
        rows.filter(
          (row) =>
            (row.result as { agent_id?: string } | null)?.agent_id === agentId,
        ),
      );

  test("GET shows the release's values until a row exists, then the row", async () => {
    const { agentId, owner, ownerId } = await setup();
    expect(await service().get(owner, agentId)).toEqual({
      source: "release",
      settings: settings(),
      settings_revision: null,
      active_release_id: expect.any(String),
      bound_credential_refs: [],
      available_servers: ["docs"],
    });
    await service().put(
      owner,
      agentId,
      request(null, { allowed_tools: [READ] }),
    );
    await db.insert(credentialBindings).values({
      id: randomUUID(),
      workspaceId: owner.ownerId,
      credentialRef: "docs-key",
      target: "agent",
      targetId: agentId,
      boundBy: ownerId,
    });
    expect(await service().get(owner, agentId)).toMatchObject({
      source: "agent",
      settings: { allowed_tools: [READ] },
      settings_revision: 1,
      bound_credential_refs: ["docs-key"],
    });
  });

  test("a first save writes revision 1 as the caller, with a receipt of the names before and after", async () => {
    const { agentId, owner, ownerId } = await setup();
    const saved = await service().put(
      owner,
      agentId,
      request(null, { allowed_tools: [SEARCH, READ] }),
    );
    expect(saved).toEqual({
      settings_revision: 1,
      receipt_id: expect.any(String),
    });
    expect(await rowOf(agentId)).toMatchObject({
      server: "docs",
      allowedTools: [READ, SEARCH],
      credentialRefs: ["docs-key"],
      revision: 1,
      updatedBy: ownerId,
    });

    const next = await service().put(
      owner,
      agentId,
      request(1, { allowed_tools: [READ], credential_refs: ["docs-key", "x"] }),
    );
    expect(next.settings_revision).toBe(2);
    const [first, second] = (await receiptsOf(agentId)).sort(
      (a, b) =>
        (a.result as { agent_settings_revision: number })
          .agent_settings_revision -
        (b.result as { agent_settings_revision: number })
          .agent_settings_revision,
    );
    expect(first?.result).toMatchObject({
      change: "settings",
      agent_settings_revision: 1,
      before: null,
      after: {
        server: "docs",
        allowed_tools: [READ, SEARCH],
        credential_refs: ["docs-key"],
      },
    });
    expect(second?.result).toMatchObject({
      agent_settings_revision: 2,
      before: { allowed_tools: [READ, SEARCH] },
      after: {
        allowed_tools: [READ],
        credential_refs: ["docs-key", "x"],
      },
    });
    expect(second?.id).toBe(next.receipt_id ?? "");
  });

  test("the agent's activity list carries the save as an access change, names only", async () => {
    const { agentId, workspaceId, owner, ownerId } = await setup();
    const saved = await service().put(
      owner,
      agentId,
      request(null, { allowed_tools: [READ] }),
    );
    const items = await createPostgresAgentGitHubStore(db).activity(
      workspaceId,
      agentId,
      { userId: ownerId, apiKeyId: null },
      20,
    );
    const receipt = items.find((item) => item.id === saved.receipt_id);
    expect(receipt).toMatchObject({
      operation: "set_agent_mcp",
      status: "succeeded",
      result: {
        change: "settings",
        before: null,
        after: {
          server: "docs",
          allowed_tools: [READ],
          credential_refs: ["docs-key"],
        },
      },
    });
    const other = await setup();
    await service().put(other.owner, other.agentId, request(null));
    const again = await createPostgresAgentGitHubStore(db).activity(
      workspaceId,
      agentId,
      { userId: ownerId, apiKeyId: null },
      20,
    );
    expect(again.map((item) => item.id)).toEqual(items.map((i) => i.id));
  });

  test("a save with the revision it did not read is a conflict and writes nothing", async () => {
    const { agentId, owner } = await setup();
    await service().put(owner, agentId, request(null));
    // The agent has a row now, so "no row" is stale; so is any other number.
    expect(await refusal(service().put(owner, agentId, request(null)))).toBe(
      "REVISION_CONFLICT:",
    );
    expect(
      await refusal(
        service().put(owner, agentId, request(7, { allowed_tools: [] })),
      ),
    ).toBe("REVISION_CONFLICT:");
    expect(await rowOf(agentId)).toMatchObject({
      revision: 1,
      allowedTools: [READ, SEARCH],
    });
    expect(await receiptsOf(agentId)).toHaveLength(1);
  });

  test("two saves from the same revision: one wins, the other conflicts", async () => {
    const { agentId, owner } = await setup();
    await service().put(owner, agentId, request(null));
    const results = await Promise.allSettled([
      service().put(owner, agentId, request(1, { allowed_tools: [READ] })),
      service().put(owner, agentId, request(1, { allowed_tools: [SEARCH] })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await rowOf(agentId))?.revision).toBe(2);
  });

  test("two first saves race: one wins", async () => {
    const { agentId, owner } = await setup();
    const results = await Promise.allSettled([
      service().put(owner, agentId, request(null, { allowed_tools: [READ] })),
      service().put(owner, agentId, request(null, { allowed_tools: [SEARCH] })),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await rowOf(agentId))?.revision).toBe(1);
  });

  test("saving what a person's row already holds changes nothing; a copied row becomes a person's", async () => {
    const { agentId, owner, ownerId, workspaceId } = await setup();
    // A row the migration copied: nobody's, revision 1.
    await db.insert(agentMcpSettings).values({
      agentId,
      workspaceId,
      server: "docs",
      allowedTools: [READ, SEARCH],
      credentialRefs: ["docs-key"],
      updatedBy: null,
    });
    const first = await service().put(owner, agentId, request(1));
    expect(first.settings_revision).toBe(2);
    expect(first.receipt_id).not.toBeNull();
    expect(await rowOf(agentId)).toMatchObject({
      revision: 2,
      updatedBy: ownerId,
    });
    const again = await service().put(owner, agentId, request(2));
    expect(again).toEqual({ settings_revision: 2, receipt_id: null });
    expect(await receiptsOf(agentId)).toHaveLength(1);
  });

  test("a member cannot save, and a key cannot: no row, no receipt, so no row can have updated_by null from a save", async () => {
    const { agentId, member, byKey } = await setup();
    expect(
      await refusal(service().put(member, agentId, request(null))),
    ).toStartWith("FORBIDDEN");
    expect(await refusal(service().put(byKey, agentId, request(null)))).toBe(
      "FORBIDDEN:web_session_required",
    );
    expect(await rowOf(agentId)).toBeUndefined();
    expect(await receiptsOf(agentId)).toHaveLength(0);
    // Nor may a member read what only managers read.
    expect(await refusal(service().get(member, agentId))).toStartWith(
      "FORBIDDEN",
    );
  });

  test("a refused value writes nothing", async () => {
    const { agentId, owner } = await setup();
    for (const [over, reason] of [
      [{ allowed_tools: ["mcp__wiki__read"] }, "tool_outside_server"],
      [{ allowed_tools: [READ, READ] }, "duplicate"],
      [{ credential_refs: ["docs-key", "docs-key"] }, "duplicate"],
      [{ credential_refs: [] }, "server_credential_missing"],
      [{ server: "nowhere", allowed_tools: [] }, "server_unknown"],
      [{ server: "github", allowed_tools: [] }, "server_builtin"],
      [{ server: null }, "server_required"],
    ] as const) {
      expect(
        await refusal(service().put(owner, agentId, request(null, over))),
      ).toBe(`BAD_REQUEST:${reason}`);
    }
    expect(await rowOf(agentId)).toBeUndefined();
    expect(await receiptsOf(agentId)).toHaveLength(0);
  });

  test("a tool the active release's snapshot blocks cannot be added; one it leaves open can; a held one can be narrowed past", async () => {
    const { agentId, owner } = await setup({
      snapshot: { mcp_deny: [SEARCH] },
    });
    expect(await refusal(service().put(owner, agentId, request(null)))).toBe(
      "BAD_REQUEST:mcp_tool_denied",
    );
    expect(await rowOf(agentId)).toBeUndefined();
    expect(
      await refusal(
        service().put(owner, agentId, request(null, { allowed_tools: [READ] })),
      ),
    ).toBe("saved");
    // The deny lands after a row already held the tool: narrowing still works.
    await db
      .update(agentMcpSettings)
      .set({ allowedTools: [READ, SEARCH] })
      .where(eq(agentMcpSettings.agentId, agentId));
    const held = await rowOf(agentId);
    expect(
      await refusal(
        service().put(
          owner,
          agentId,
          request(held?.revision ?? null, { allowed_tools: [SEARCH] }),
        ),
      ),
    ).toBe("saved");
    expect((await rowOf(agentId))?.allowedTools).toEqual([SEARCH]);
  });

  test("a save narrows a running session at once and widens only sessions that start after it", async () => {
    const { agentId, releaseId, workspaceId, owner } = await setup();
    await service().put(
      owner,
      agentId,
      request(null, { allowed_tools: [READ] }),
    );
    const start = await db.transaction((tx) => captureMcpStart(tx, releaseId));
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      ...sessionPinColumns(),
      agentReleaseId: releaseId,
      mcpStart: start,
    });
    const toolsNow = async () =>
      (
        await createPostgresMcpEgressStore(db).sessionState({
          sessionId,
          attemptId: randomUUID(),
        })
      )?.tools;
    expect(await toolsNow()).toEqual([READ]);

    // Widened: the running session does not gain a tool it did not start with.
    await service().put(
      owner,
      agentId,
      request(1, { allowed_tools: [READ, SEARCH] }),
    );
    expect(await toolsNow()).toEqual([READ]);
    const next = await db.transaction((tx) => captureMcpStart(tx, releaseId));
    expect(next?.allowed_tools).toEqual([READ, SEARCH]);

    // Narrowed: the tool is gone from the running session at once.
    await service().put(owner, agentId, request(2, { allowed_tools: [] }));
    expect(await toolsNow()).toEqual([]);
    // A tool taken out and put back is open again inside the snapshot's limit,
    // and a tool the snapshot never had stays shut.
    await service().put(
      owner,
      agentId,
      request(3, { allowed_tools: [READ, SEARCH] }),
    );
    expect(await toolsNow()).toEqual([READ]);
  });

  test("a save from a person who no longer belongs is refused", async () => {
    const { agentId, owner, workspaceId, ownerId } = await setup();
    await db
      .delete(memberships)
      .where(
        and(
          eq(memberships.workspaceId, workspaceId),
          eq(memberships.userId, ownerId),
        ),
      );
    expect(
      await refusal(service().put(owner, agentId, request(null))),
    ).not.toBe("saved");
    expect(await rowOf(agentId)).toBeUndefined();
  });

  test("saving needs no binding: the names can be written before they are bound", async () => {
    const { agentId, owner } = await setup();
    const saved = await service().put(
      owner,
      agentId,
      request(null, { credential_refs: ["docs-key", "not-bound-yet"] }),
    );
    expect(saved.settings_revision).toBe(1);
  });
});
