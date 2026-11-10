import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { agentCardSchema, scopesForRole } from "@werft-ai/contracts";
import {
  type Caller,
  type CatalogProfile,
  callerFor,
  catalogRows,
  installationProfileSnapshot,
  resolveReleaseContent,
  resolveSessionCatalog,
} from "@werft-ai/platform";
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
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentMcpSettings,
  agentReleases,
  agents,
  agentVersions,
  credentialBindings,
  memberships,
  sessions,
  users,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";

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
    options: {
      snapshot?: Record<string, unknown>;
      refs?: string[];
      perTool?: Record<string, string>;
    } = {},
  ) {
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
          credential_refs: options.refs ?? ["docs-key"],
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
          per_tool: options.perTool ?? {
            [READ]: "allow",
            [SEARCH]: "allow",
            mcp__docs__x: "ask",
          },
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
    await saveSettings(workspaceId, agentId, {
      server: "wiki",
      allowedTools: ["mcp__wiki__read"],
    });
    expect(await stateOf(sessionId)).toMatchObject({
      server: "docs",
      tools: [],
    });
  });

  // Waits until some backend of this database is waiting on a lock, so a
  // test acts after the statement under test is truly held, not after a delay.
  async function untilSomeoneWaits() {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const { rows } = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND cardinality(pg_blocking_pids(pid)) > 0",
      );
      if ((rows[0]?.n ?? 0) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("no statement ever waited on a lock");
  }

  test("a session start waits for a save that holds the row, and snapshots what it saved", async () => {
    const workspaceId = await workspace();
    const { agentId, releaseId } = await agentOnRelease(workspaceId);
    await saveSettings(workspaceId, agentId, { allowedTools: [READ, SEARCH] });
    const saver = await pool.connect();
    try {
      // A save in flight: the row locked and changed, not yet committed.
      await saver.query("BEGIN");
      await saver.query(
        "SELECT 1 FROM agent_mcp_settings WHERE agent_id = $1 FOR UPDATE",
        [agentId],
      );
      await saver.query(
        "UPDATE agent_mcp_settings SET allowed_tools = $2::jsonb, revision = revision + 1 WHERE agent_id = $1",
        [agentId, JSON.stringify([READ])],
      );
      let settled = false;
      const starting = db
        .transaction((tx) => captureMcpStart(tx, releaseId))
        .finally(() => {
          settled = true;
        });
      await untilSomeoneWaits();
      expect(settled).toBe(false);
      await saver.query("COMMIT");
      // It saw the save, not the row as it was before it.
      expect(await starting).toMatchObject({
        allowed_tools: [READ],
        revision: 2,
      });
    } finally {
      saver.release();
    }
  });

  test("a session that will follow its release is judged on the card's names, whatever a row says", async () => {
    const workspaceId = await workspace();
    const { agentId, releaseId } = await agentOnRelease(workspaceId);
    // A row that appeared after the create read none, with no names.
    await saveSettings(workspaceId, agentId, { credentialRefs: [] });
    await db.transaction(async (tx) => {
      expect(
        await lockUnboundRefs(tx, {
          workspaceId,
          releaseId,
          fromRelease: true,
        }),
      ).toEqual(["docs-key"]);
      expect(await lockUnboundRefs(tx, { workspaceId, releaseId })).toEqual([]);
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

  test("a release deny pin beats the agent's saved allow in both kinds of session", async () => {
    const workspaceId = await workspace();
    const { agentId, releaseId } = await agentOnRelease(workspaceId, {
      perTool: { [READ]: "allow", [SEARCH]: "deny" },
    });
    // The agent's own settings allow the denied name too.
    await saveSettings(workspaceId, agentId, { updatedBy: await person() });
    expect(
      (await stateOf(await sessionOn(workspaceId, releaseId)))?.tools,
    ).toEqual([READ]);
    const started = await db.transaction((tx) =>
      captureMcpStart(tx, releaseId),
    );
    const snapshot = await sessionOn(workspaceId, releaseId, started);
    expect((await stateOf(snapshot))?.tools).toEqual([READ]);
    expect(
      await sessionMcpOf(db, { agentReleaseId: releaseId, mcpStart: started }),
    ).toMatchObject({ tools: [READ] });
  });

  // The chain a stored profile takes to a refused call: its deny column, the
  // registry's profile, the release content the agent service writes, the
  // stored release and the egress judgement of a session on it.
  test("an mcp__ name in a stored profile's deny ends as a refused call", async () => {
    const provider = {
      kind: "anthropic" as const,
      endpoint: "https://api.anthropic.invalid",
      auth: { kind: "api_key" as const, value_env: "PROVIDER_KEY" },
    };
    const stored = catalogRows({
      coding: {
        runtime_kind: "claude_agent_sdk",
        runtime_version: "0.3.270",
        model: "claude-sonnet-5",
        models: ["claude-sonnet-5"],
        tools: ["Read"],
        permission_mode: "default",
        provider,
        project_settings: { claude_md: false },
        repository: "none",
      },
    }).map((row) => ({ ...row, deny: ["WebSearch", SEARCH, READ] }));
    const snapshot = installationProfileSnapshot<CatalogProfile>(
      {
        connections: { main: provider },
        allowUnattended: false,
        runtimeSupported: () => true,
        materialize: (id, definition) => {
          const profile = resolveSessionCatalog(
            { profiles: { [id]: definition }, repositories: {} },
            () => "a-provider-key",
          ).profiles[id];
          if (!profile) throw new Error(`no ${id}`);
          return profile as CatalogProfile;
        },
      },
      stored,
    );
    const profile = snapshot.profiles.coding;
    if (!profile) throw new Error("the profile did not run");
    const content = resolveReleaseContent(
      agentCardSchema.parse({
        role: "r",
        instructions: "i",
        model: "claude-sonnet-5",
        capabilities: { mcp: null, forbidden: [] },
      }),
      "coding",
      profile,
    );
    if (!content.ok) throw new Error(content.error.message);
    expect(content.content.runtime_config_snapshot.mcp_deny).toEqual([
      READ,
      SEARCH,
    ]);

    const workspaceId = await workspace();
    const { releaseId } = await agentOnRelease(workspaceId, {
      snapshot: content.content.runtime_config_snapshot,
    });
    expect(
      (await stateOf(await sessionOn(workspaceId, releaseId)))?.tools,
    ).toEqual([]);
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

  describe("through the session unit of work", () => {
    const uow = () => createPostgresSessionUnitOfWork(db);
    const limits = {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
    };

    async function owner(workspaceId: string) {
      const userId = await person();
      await db
        .insert(memberships)
        .values({ workspaceId, userId, role: "owner" });
      return callerFor(
        {
          kind: "user",
          id: userId,
          workspace_id: workspaceId,
          role: "owner",
          scopes: [...scopesForRole("owner")],
        },
        { kind: "web" },
        randomUUID(),
      );
    }

    async function bound(workspaceId: string, agentId: string, ref: string) {
      await db.insert(credentialBindings).values({
        id: randomUUID(),
        workspaceId,
        credentialRef: ref,
        target: "agent",
        targetId: agentId,
        boundBy: await person(),
      });
    }

    const create = (caller: Caller, releaseId: string) =>
      uow().acceptInputAtomic({
        limits,
        principal: caller,
        idempotencyKey: randomUUID(),
        payloadHash: randomUUID(),
        profileId: "coding",
        repository: "none",
        agentReleaseId: releaseId,
        message: "hello",
      });

    const startOf = async (releaseId: string) =>
      (
        await db
          .select({ mcpStart: sessions.mcpStart })
          .from(sessions)
          .where(eq(sessions.agentReleaseId, releaseId))
      ).map((row) => row.mcpStart);

    test("create stores the snapshot of the row, or none without a row", async () => {
      const workspaceId = await workspace();
      const caller = await owner(workspaceId);
      const plain = await agentOnRelease(workspaceId);
      await bound(workspaceId, plain.agentId, "docs-key");
      expect((await create(caller, plain.releaseId)).outcome).toBe("accepted");
      expect(await startOf(plain.releaseId)).toEqual([null]);

      const set = await agentOnRelease(workspaceId);
      await bound(workspaceId, set.agentId, "docs-key");
      await saveSettings(workspaceId, set.agentId, { allowedTools: [READ] });
      expect((await create(caller, set.releaseId)).outcome).toBe("accepted");
      expect(await startOf(set.releaseId)).toEqual([
        {
          server: "docs",
          allowed_tools: [READ],
          credential_refs: ["docs-key"],
          revision: 1,
        },
      ]);
    });

    test("create judges the release's names when the row appears after it read none", async () => {
      const workspaceId = await workspace();
      const caller = await owner(workspaceId);
      // The card needs two names; only one is bound, so the other is unbound.
      const { agentId, releaseId } = await agentOnRelease(workspaceId, {
        refs: ["docs-key", "wiki-key"],
      });
      await bound(workspaceId, agentId, "docs-key");
      const holder = await pool.connect();
      try {
        // The binding row held, so create stops at its unbound check, after
        // it has read no settings row and before it looks at any name.
        await holder.query("BEGIN");
        await holder.query(
          "SELECT 1 FROM credential_bindings WHERE target_id = $1 AND revoked_at IS NULL FOR UPDATE",
          [agentId],
        );
        const creating = create(caller, releaseId);
        await untilSomeoneWaits();
        // A row with no names arrives and commits in that gap.
        await saveSettings(workspaceId, agentId, { credentialRefs: [] });
        await holder.query("COMMIT");
        // The session follows its release, so the card's other name counts.
        expect((await creating).outcome).toBe("credential_unbound");
        expect(await startOf(releaseId)).toEqual([]);
      } finally {
        holder.release();
      }
    });

    test("create judges the names it stores, a message the names it started with", async () => {
      const workspaceId = await workspace();
      const caller = await owner(workspaceId);
      const { agentId, releaseId } = await agentOnRelease(workspaceId);
      await bound(workspaceId, agentId, "docs-key");
      await saveSettings(workspaceId, agentId);
      const first = await create(caller, releaseId);
      expect(first.outcome).toBe("accepted");
      const [session] = await db
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.agentReleaseId, releaseId));

      // The settings gain a name nobody bound.
      await saveSettings(workspaceId, agentId, {
        credentialRefs: ["docs-key", "wiki-key"],
      });
      expect((await create(caller, releaseId)).outcome).toBe(
        "credential_unbound",
      );
      expect(await startOf(releaseId)).toHaveLength(1);
      const appended = await uow().appendInputAtomic({
        principal: caller,
        sessionId: session?.id ?? "",
        idempotencyKey: randomUUID(),
        payloadHash: randomUUID(),
        message: "again",
        limits,
      });
      expect(appended.outcome).toBe("accepted");
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
