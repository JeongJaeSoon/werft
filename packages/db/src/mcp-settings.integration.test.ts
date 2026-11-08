import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { lockUnboundRefs } from "./credential-bindings.ts";
import { createPostgresMcpEgressStore, sessionMcpOf } from "./mcp-egress.ts";
import { captureMcpStart } from "./mcp-settings.ts";
import * as schema from "./schema.ts";
import {
  agentMcpSettings,
  agentReleases,
  agents,
  agentVersions,
  credentialBindings,
  sessions,
  users,
  workspaces,
} from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const READ = "mcp__docs__read";
const SEARCH = "mcp__docs__search";

async function refusal(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? String(error);
  }
  return "accepted";
}

integration("agent MCP settings on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "mcp_settings_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  async function person() {
    const userId = randomUUID();
    await db.insert(users).values({
      id: userId,
      email: `u-${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "u",
    });
    return userId;
  }

  // An agent whose release card names the `docs` server and `docs-key`, with
  // the pins `resolveReleaseContent` writes; raw, so the stored shape is the
  // one under test.
  async function agentOnRelease(
    workspaceId: string,
    options: { snapshot?: Record<string, unknown> } = {},
  ) {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      workspaceId,
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
      runtimeProfileId: "coding",
      profileDigest: "digest",
      runtimeConfigSnapshot: options.snapshot ?? {},
      effectiveTools: { tools: [], mcp: [READ] },
      policyPins: {
        tools: {
          default: { builtin: "allow", mcp: "ask" },
          per_tool: { [READ]: "allow", [SEARCH]: "allow", mcp__docs__x: "ask" },
        },
      },
    });
    return { agentId, releaseId };
  }

  async function saveSettings(
    workspaceId: string,
    agentId: string,
    over: Partial<typeof agentMcpSettings.$inferInsert> = {},
  ) {
    await db
      .insert(agentMcpSettings)
      .values({
        agentId,
        workspaceId,
        server: "docs",
        allowedTools: [READ, SEARCH],
        credentialRefs: ["docs-key"],
        ...over,
      })
      .onConflictDoUpdate({
        target: agentMcpSettings.agentId,
        set: {
          ...over,
          revision: 2,
        },
      });
  }

  async function sessionOn(
    workspaceId: string,
    releaseId: string,
    mcpStart: unknown = null,
  ) {
    const id = randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: workspaceId,
      workspaceId,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      agentReleaseId: releaseId,
      mcpStart,
    });
    return id;
  }

  const stateOf = (sessionId: string) =>
    createPostgresMcpEgressStore(db).sessionState({
      sessionId,
      attemptId: randomUUID(),
    });

  test("with no settings row every reader gives what the release gave before", async () => {
    const workspaceId = await workspace();
    const { agentId, releaseId } = await agentOnRelease(workspaceId);
    const sessionId = await sessionOn(workspaceId, releaseId);

    expect(await captureMcpStart(db, releaseId)).toBeNull();
    expect(
      await sessionMcpOf(db, { agentReleaseId: releaseId, mcpStart: null }),
    ).toEqual({ releaseId, server: "docs", tools: [READ, SEARCH] });
    expect(await stateOf(sessionId)).toMatchObject({
      agentId,
      server: "docs",
      tools: [READ, SEARCH],
    });
    await db.transaction(async (tx) => {
      expect(await lockUnboundRefs(tx, { workspaceId, releaseId })).toEqual([
        "docs-key",
      ]);
    });
  });

  test("a snapshot is taken from the row, and the row gone gives none", async () => {
    const workspaceId = await workspace();
    const { agentId, releaseId } = await agentOnRelease(workspaceId);
    await saveSettings(workspaceId, agentId, { allowedTools: [READ] });
    expect(await captureMcpStart(db, releaseId)).toEqual({
      server: "docs",
      allowed_tools: [READ],
      credential_refs: ["docs-key"],
      revision: 1,
    });
  });

  test("a change to the row narrows a running session at once and widens only the next", async () => {
    const workspaceId = await workspace();
    const { agentId, releaseId } = await agentOnRelease(workspaceId);
    await saveSettings(workspaceId, agentId, { allowedTools: [READ] });
    const started = await db.transaction((tx) =>
      captureMcpStart(tx, releaseId),
    );
    const sessionId = await sessionOn(workspaceId, releaseId, started);

    // Widened after the start: the running session keeps its two-tool limit.
    await saveSettings(workspaceId, agentId, { allowedTools: [READ, SEARCH] });
    expect((await stateOf(sessionId))?.tools).toEqual([READ]);
    const next = await db.transaction((tx) => captureMcpStart(tx, releaseId));
    expect(next?.allowed_tools).toEqual([READ, SEARCH]);

    // Narrowed: gone from the running session in the next read.
    await saveSettings(workspaceId, agentId, { allowedTools: [SEARCH] });
    expect((await stateOf(sessionId))?.tools).toEqual([]);

    // Another server closes it, and the claim keeps the server it started on.
    await saveSettings(workspaceId, agentId, { server: "wiki" });
    expect(await stateOf(sessionId)).toMatchObject({
      server: "docs",
      tools: [],
    });
  });

  test("a release session is narrowed by a person's row, not by a copied one", async () => {
    const workspaceId = await workspace();
    const { agentId, releaseId } = await agentOnRelease(workspaceId);
    const sessionId = await sessionOn(workspaceId, releaseId);

    await saveSettings(workspaceId, agentId, {
      allowedTools: [],
      updatedBy: null,
    });
    expect((await stateOf(sessionId))?.tools).toEqual([READ, SEARCH]);

    await saveSettings(workspaceId, agentId, {
      allowedTools: [READ],
      updatedBy: await person(),
    });
    expect((await stateOf(sessionId))?.tools).toEqual([READ]);
  });

  test("the release's mcp_deny is taken out of both kinds of session", async () => {
    const workspaceId = await workspace();
    const { agentId, releaseId } = await agentOnRelease(workspaceId, {
      snapshot: { mcp_deny: [SEARCH] },
    });
    const release = await sessionOn(workspaceId, releaseId);
    expect((await stateOf(release))?.tools).toEqual([READ]);

    await saveSettings(workspaceId, agentId);
    const started = await db.transaction((tx) =>
      captureMcpStart(tx, releaseId),
    );
    const snapshot = await sessionOn(workspaceId, releaseId, started);
    expect((await stateOf(snapshot))?.tools).toEqual([READ]);
    expect(
      await sessionMcpOf(db, { agentReleaseId: releaseId, mcpStart: started }),
    ).toMatchObject({ tools: [READ] });
  });

  test("a new session needs the row's names, a running one its own", async () => {
    const workspaceId = await workspace();
    const { agentId, releaseId } = await agentOnRelease(workspaceId);
    const userId = await person();
    await db.insert(credentialBindings).values({
      id: randomUUID(),
      workspaceId,
      credentialRef: "docs-key",
      target: "agent",
      targetId: agentId,
      boundBy: userId,
    });
    await saveSettings(workspaceId, agentId, { credentialRefs: ["docs-key"] });
    const started = await db.transaction((tx) =>
      captureMcpStart(tx, releaseId),
    );
    const sessionId = await sessionOn(workspaceId, releaseId, started);

    // The settings gain a name nobody bound.
    await saveSettings(workspaceId, agentId, {
      credentialRefs: ["docs-key", "wiki-key"],
    });
    await db.transaction(async (tx) => {
      expect(await lockUnboundRefs(tx, { workspaceId, releaseId })).toEqual([
        "wiki-key",
      ]);
      expect(
        await lockUnboundRefs(tx, { workspaceId, releaseId, sessionId }),
      ).toEqual([]);
    });
  });

  test("the table refuses a malformed server, a non-array and 33 names", async () => {
    const workspaceId = await workspace();
    const { agentId } = await agentOnRelease(workspaceId);
    const base = {
      agentId,
      workspaceId,
      allowedTools: [],
      credentialRefs: [],
    };
    expect(
      await refusal(
        db.insert(agentMcpSettings).values({ ...base, server: "a__b" }),
      ),
    ).toBe("agent_mcp_settings_server_check");
    expect(
      await refusal(
        db.insert(agentMcpSettings).values({
          ...base,
          credentialRefs: Array.from({ length: 33 }, (_, i) => `ref-${i}`),
        }),
      ),
    ).toBe("agent_mcp_settings_credential_refs_check");
    expect(
      await refusal(
        db
          .insert(agentMcpSettings)
          .values({ ...base, allowedTools: {} as unknown as string[] }),
      ),
    ).toBe("agent_mcp_settings_allowed_tools_check");
    expect(await refusal(db.insert(agentMcpSettings).values({ ...base }))).toBe(
      "accepted",
    );
    const [row] = await db
      .select()
      .from(agentMcpSettings)
      .where(eq(agentMcpSettings.agentId, agentId));
    expect(row).toMatchObject({ server: null, revision: 1, updatedBy: null });
  });
});
