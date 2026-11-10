import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  ENV_AGENT_VARIABLE_LIMIT,
  ENV_WORKSPACE_VARIABLE_LIMIT,
} from "@werft-ai/contracts";
import { hashWorkerToken, type Principal } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  createPostgresEnvVariableStore,
  ENV_START_RETENTION_MS,
  purgeExpiredEnvStart,
} from "./env-variables.ts";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import {
  agentReleases,
  agents,
  agentVersions,
  attempts,
  envVariableGrants,
  envVariables,
  executions,
  queueMessages,
  receipts,
  sessions,
  turns,
  workerLaunches,
  workspaces,
} from "./schema.ts";
import { fixtureTeam } from "./testing/fixture-team.ts";
import { launchSession } from "./testing/launches.ts";
import {
  releaseSpecColumns,
  TEST_CONNECTION_ID,
  TEST_MODEL,
  testClaimCatalog,
} from "./testing/spec-pins.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };

async function refusal(query: PromiseLike<unknown>): Promise<string> {
  try {
    await query;
  } catch (error) {
    const cause = (error as { cause?: { constraint?: string } }).cause;
    return cause?.constraint ?? String(error);
  }
  return "accepted";
}

integration("user variables on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "env_variables_it" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const store = () => createPostgresEnvVariableStore(db);
  const inputs = () => createPostgresSessionUnitOfWork(db);

  async function workspace() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
    return workspaceId;
  }

  const principal = (workspaceId: string): Principal => ({
    ownerId: workspaceId,
  });

  async function agentOn(workspaceId: string) {
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
        capabilities: { tools: null, mcp: [], forbidden: [] },
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
      runtimeConfigSnapshot: {},
      effectiveTools: { tools: [], mcp: [] },
      policyPins: {
        tools: { default: { builtin: "allow", mcp: "ask" }, per_tool: {} },
      },
    });
    return { agentId, releaseId };
  }

  const put = (
    workspaceId: string,
    agentId: string | null,
    name: string,
    value: string,
    precondition: { create: true } | { ifMatch: number } = { create: true },
  ) =>
    store().put({
      principal: principal(workspaceId),
      scope: { workspaceId, agentId },
      name,
      value,
      precondition,
    });

  async function saved(
    workspaceId: string,
    agentId: string | null,
    name: string,
    value: string,
  ) {
    const result = await put(workspaceId, agentId, name, value);
    if (result.outcome !== "saved") throw new Error(result.outcome);
    return result;
  }

  async function grant(
    workspaceId: string,
    name: string,
    agentIds: string[],
    grantAll = false,
  ) {
    const [row] = await db
      .select({ grantVersion: envVariables.grantVersion })
      .from(envVariables)
      .where(
        and(
          eq(envVariables.workspaceId, workspaceId),
          eq(envVariables.name, name),
        ),
      );
    const result = await store().setGrants({
      principal: principal(workspaceId),
      workspaceId,
      name,
      ifMatch: row?.grantVersion ?? 0,
      grantAll,
      agents: agentIds.map((id) => ({ id, allowAutomation: false })),
    });
    if (result.outcome !== "saved") throw new Error(result.outcome);
  }

  async function accept(
    workspaceId: string,
    releaseId: string,
    envNames: string[] | undefined,
    idempotencyKey: string = randomUUID(),
  ) {
    return inputs().acceptInputAtomic({
      principal: principal(workspaceId),
      idempotencyKey,
      payloadHash: "h",
      model: TEST_MODEL,
      repository: "none",
      agentReleaseId: releaseId,
      ...(envNames === undefined ? {} : { envNames }),
      message: "go",
      limits: LIMITS,
    });
  }

  async function accepted(
    workspaceId: string,
    releaseId: string,
    envNames: string[] | undefined,
  ) {
    const result = await accept(workspaceId, releaseId, envNames);
    if (result.outcome !== "accepted") throw new Error(result.outcome);
    return result.response.session_id;
  }

  const envStartOf = async (sessionId: string) =>
    (
      await db
        .select({ envStart: sessions.envStart })
        .from(sessions)
        .where(eq(sessions.id, sessionId))
    )[0]?.envStart;

  const receiptsOf = (workspaceId: string, operation: string) =>
    db
      .select()
      .from(receipts)
      .where(
        and(
          eq(receipts.ownerId, workspaceId),
          eq(receipts.operation, operation),
        ),
      );

  describe("the tables", () => {
    test("each rule the design states is a constraint, not only a service check", async () => {
      const workspaceId = await workspace();
      const { agentId } = await agentOn(workspaceId);
      const row = (over: Partial<typeof envVariables.$inferInsert>) =>
        db.insert(envVariables).values({
          id: randomUUID(),
          workspaceId,
          name: `N_${randomUUID().slice(0, 8).toUpperCase().replace(/-/g, "")}`,
          kind: "plain",
          value: "v",
          ...over,
        });

      expect(await refusal(row({ name: "lower_case" }))).toBe(
        "env_variables_name_check",
      );
      expect(await refusal(row({ name: `A${"B".repeat(64)}` }))).toBe(
        "env_variables_name_check",
      );
      expect(await refusal(row({ kind: "other" }))).toBe(
        "env_variables_kind_check",
      );
      // A secret never keeps its value here; a plain variable always does.
      expect(
        await refusal(row({ kind: "secret", value: "twelve-chars-or-more" })),
      ).toBe("env_variables_value_check");
      expect(await refusal(row({ kind: "plain", value: null }))).toBe(
        "env_variables_value_check",
      );
      expect(await refusal(row({ value: "x".repeat(48 * 1024 + 1) }))).toBe(
        "env_variables_value_check",
      );
      expect(await refusal(row({ value: "x".repeat(48 * 1024) }))).toBe(
        "accepted",
      );
      expect(await refusal(row({ engineDelivery: true }))).toBe(
        "env_variables_engine_delivery_check",
      );
      expect(
        await refusal(row({ kind: "secret", value: null, grantAll: true })),
      ).toBe("env_variables_grant_all_check");
      expect(await refusal(row({ agentId, grantAll: true }))).toBe(
        "env_variables_grant_all_check",
      );
      expect(
        await refusal(
          row({ kind: "secret", value: null, allowAutomation: true }),
        ),
      ).toBe("env_variables_allow_automation_check");
      // The agent must belong to the workspace.
      expect(await refusal(row({ agentId: randomUUID() }))).toBe(
        "env_variables_agent_fk",
      );
    });

    test("a name is unique per scope, and a workspace and an agent may share it", async () => {
      const workspaceId = await workspace();
      const { agentId } = await agentOn(workspaceId);
      await saved(workspaceId, null, "SHARED", "ws");
      await saved(workspaceId, agentId, "SHARED", "agent");
      const again = await refusal(
        db.insert(envVariables).values({
          id: randomUUID(),
          workspaceId,
          name: "SHARED",
          kind: "plain",
          value: "dup",
        }),
      );
      expect(again).toBe("env_variables_workspace_name_uniq");
    });

    test("a grant cannot name another workspace's agent, and goes with its variable", async () => {
      const workspaceId = await workspace();
      const other = await workspace();
      const { agentId } = await agentOn(workspaceId);
      const { agentId: foreign } = await agentOn(other);
      await saved(workspaceId, null, "GRANTED", "v");
      const [variable] = await db
        .select()
        .from(envVariables)
        .where(eq(envVariables.workspaceId, workspaceId));
      if (!variable) throw new Error("no variable");
      expect(
        await refusal(
          db.insert(envVariableGrants).values({
            workspaceId,
            variableId: variable.id,
            agentId: foreign,
          }),
        ),
      ).toBe("env_variable_grants_agent_fk");
      await db.insert(envVariableGrants).values({
        workspaceId,
        variableId: variable.id,
        agentId,
      });
      await db.delete(envVariables).where(eq(envVariables.id, variable.id));
      expect(
        await db
          .select()
          .from(envVariableGrants)
          .where(eq(envVariableGrants.variableId, variable.id)),
      ).toEqual([]);
    });
  });

  describe("the store", () => {
    test("create needs If-None-Match, replace needs the version last read", async () => {
      const workspaceId = await workspace();
      const first = await saved(workspaceId, null, "TOKEN_URL", "one");
      expect(await put(workspaceId, null, "TOKEN_URL", "two")).toEqual({
        outcome: "version_mismatch",
        current: first.version,
      });
      expect(
        await put(workspaceId, null, "TOKEN_URL", "two", {
          ifMatch: first.version + 1000,
        }),
      ).toEqual({ outcome: "version_mismatch", current: first.version });
      expect(
        await put(workspaceId, null, "MISSING_ONE", "x", { ifMatch: 1 }),
      ).toEqual({ outcome: "version_mismatch", current: null });
      const second = await put(workspaceId, null, "TOKEN_URL", "two", {
        ifMatch: first.version,
      });
      expect(second).toMatchObject({ outcome: "saved", created: false });
      if (second.outcome !== "saved") return;
      expect(second.version).toBeGreaterThan(first.version);
      const [listed] = await store().list({ workspaceId, agentId: null });
      expect(listed).toMatchObject({
        name: "TOKEN_URL",
        value: "two",
        version: second.version,
      });
    });

    test("a deleted and re-created variable never repeats a version", async () => {
      const workspaceId = await workspace();
      const first = await saved(workspaceId, null, "AGAIN_ONE", "a");
      const deleted = await store().delete({
        principal: principal(workspaceId),
        scope: { workspaceId, agentId: null },
        name: "AGAIN_ONE",
        ifMatch: first.version,
      });
      expect(deleted.outcome).toBe("deleted");
      const second = await saved(workspaceId, null, "AGAIN_ONE", "a");
      expect(second.version).toBeGreaterThan(first.version);
      // The `If-Match` read before the delete does not match the new row.
      expect(
        await put(workspaceId, null, "AGAIN_ONE", "b", {
          ifMatch: first.version,
        }),
      ).toMatchObject({ outcome: "version_mismatch" });
    });

    test("writers racing for the last place leave exactly one winner", async () => {
      const workspaceId = await workspace();
      for (let i = 0; i < ENV_WORKSPACE_VARIABLE_LIMIT - 1; i++) {
        await saved(workspaceId, null, `FILL_${i}`, "v");
      }
      const results = await Promise.all(
        ["RACE_A", "RACE_B", "RACE_C", "RACE_D", "RACE_E"].map((name) =>
          put(workspaceId, null, name, "v"),
        ),
      );
      expect(results.filter((r) => r.outcome === "saved")).toHaveLength(1);
      expect(
        results.filter((r) => r.outcome === "quota_exceeded"),
      ).toHaveLength(4);
      expect(await store().list({ workspaceId, agentId: null })).toHaveLength(
        ENV_WORKSPACE_VARIABLE_LIMIT,
      );
    }, 60_000);

    test("an agent holds fewer, counted apart from the workspace's", async () => {
      const workspaceId = await workspace();
      const { agentId } = await agentOn(workspaceId);
      for (let i = 0; i < ENV_AGENT_VARIABLE_LIMIT; i++) {
        await saved(workspaceId, agentId, `OWN_${i}`, "v");
      }
      expect(await put(workspaceId, agentId, "ONE_MORE", "v")).toEqual({
        outcome: "quota_exceeded",
      });
      expect(await put(workspaceId, null, "WORKSPACE_ONE", "v")).toMatchObject({
        outcome: "saved",
      });
      expect(await put(workspaceId, randomUUID(), "GHOST_ONE", "v")).toEqual({
        outcome: "agent_not_found",
      });
    }, 60_000);

    test("an agent is found only in its own workspace", async () => {
      const workspaceId = await workspace();
      const { agentId } = await agentOn(workspaceId);
      expect(await store().hasAgent(workspaceId, agentId)).toBe(true);
      expect(await store().hasAgent(await workspace(), agentId)).toBe(false);
      expect(await store().hasAgent(workspaceId, randomUUID())).toBe(false);
    }, 60_000);

    test("the agent view returns the agent's own and the workspace's variables with grants", async () => {
      const workspaceId = await workspace();
      const { agentId } = await agentOn(workspaceId);
      expect(await put(workspaceId, null, "SHARED_ONE", "w")).toMatchObject({
        outcome: "saved",
      });
      expect(await put(workspaceId, agentId, "OWN_ONE", "a")).toMatchObject({
        outcome: "saved",
      });
      const view = await store().readAgentView(workspaceId, agentId);
      expect(view.own.map((record) => record.name)).toEqual(["OWN_ONE"]);
      expect(view.workspace.map((record) => record.name)).toEqual([
        "SHARED_ONE",
      ]);
      expect(view.workspace[0]?.grantedAgents).toEqual([]);
    }, 60_000);

    test("a delete says who received the value and which open sessions hold a copy", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      const { agentId: other } = await agentOn(workspaceId);
      const created = await saved(workspaceId, null, "SHARED_URL", "u");
      await grant(workspaceId, "SHARED_URL", [agentId, other]);
      await accepted(workspaceId, releaseId, ["SHARED_URL"]);
      const closed = await accepted(workspaceId, releaseId, ["SHARED_URL"]);
      await db
        .update(sessions)
        .set({ admissionState: "closed" })
        .where(eq(sessions.id, closed));

      const result = await store().delete({
        principal: principal(workspaceId),
        scope: { workspaceId, agentId: null },
        name: "SHARED_URL",
        ifMatch: created.version,
      });
      expect(result).toMatchObject({
        outcome: "deleted",
        affectedAgents: 2,
        openSessions: 1,
      });
      expect(
        await store().delete({
          principal: principal(workspaceId),
          scope: { workspaceId, agentId: null },
          name: "SHARED_URL",
          ifMatch: created.version,
        }),
      ).toEqual({ outcome: "not_found" });
    });

    test("grants replace the whole set under their own version", async () => {
      const workspaceId = await workspace();
      const { agentId } = await agentOn(workspaceId);
      const { agentId: other } = await agentOn(workspaceId);
      const { agentId: foreign } = await agentOn(await workspace());
      const created = await saved(workspaceId, null, "GRANT_ME", "v");
      const base = {
        principal: principal(workspaceId),
        workspaceId,
        name: "GRANT_ME",
      };
      expect(
        await store().setGrants({
          ...base,
          ifMatch: created.grantVersion + 99,
          grantAll: false,
          agents: [],
        }),
      ).toEqual({
        outcome: "version_mismatch",
        current: created.grantVersion,
      });
      expect(
        await store().setGrants({
          ...base,
          ifMatch: created.grantVersion,
          grantAll: false,
          agents: [{ id: foreign, allowAutomation: false }],
        }),
      ).toEqual({ outcome: "agent_not_found" });
      const first = await store().setGrants({
        ...base,
        ifMatch: created.grantVersion,
        grantAll: false,
        agents: [
          { id: agentId, allowAutomation: false },
          { id: other, allowAutomation: false },
        ],
      });
      if (first.outcome !== "saved") throw new Error(first.outcome);
      const second = await store().setGrants({
        ...base,
        ifMatch: first.grantVersion,
        grantAll: false,
        agents: [{ id: other, allowAutomation: false }],
      });
      if (second.outcome !== "saved") throw new Error(second.outcome);
      const [listed] = await store().list({ workspaceId, agentId: null });
      expect(listed?.grantedAgents).toEqual([
        { id: other, allowAutomation: false },
      ]);
      // A value edit leaves the grants' version alone.
      const edited = await put(workspaceId, null, "GRANT_ME", "w", {
        ifMatch: created.version,
      });
      if (edited.outcome !== "saved") throw new Error(edited.outcome);
      expect(edited.grantVersion).toBe(second.grantVersion);
    });

    test("every write leaves a receipt that carries the name and version, never the value", async () => {
      const workspaceId = await workspace();
      const { agentId } = await agentOn(workspaceId);
      const marker = "marker-value-that-must-stay-out-of-receipts";
      const created = await saved(workspaceId, null, "RECEIPT_ONE", marker);
      await grant(workspaceId, "RECEIPT_ONE", [agentId]);
      await store().delete({
        principal: principal(workspaceId),
        scope: { workspaceId, agentId: null },
        name: "RECEIPT_ONE",
        ifMatch: created.version,
      });
      const all = await db
        .select()
        .from(receipts)
        .where(eq(receipts.ownerId, workspaceId));
      expect(all.map((r) => r.operation).sort()).toEqual([
        "delete_env_variable",
        "set_env_variable",
        "set_env_variable_grants",
      ]);
      expect(JSON.stringify(all)).not.toContain(marker);
      const set = all.find((r) => r.operation === "set_env_variable");
      expect(set?.result).toMatchObject({
        name: "RECEIPT_ONE",
        version: created.version,
      });
    });
  });

  describe("a session's variables at accept", () => {
    test("a session whose card declares nothing is accepted as before", async () => {
      const workspaceId = await workspace();
      const { releaseId } = await agentOn(workspaceId);
      await saved(workspaceId, null, "UNUSED_ONE", "v");
      const none = await accepted(workspaceId, releaseId, undefined);
      const empty = await accepted(workspaceId, releaseId, []);
      expect(await envStartOf(none)).toBeNull();
      expect(await envStartOf(empty)).toBeNull();
      expect(await receiptsOf(workspaceId, "resolve_session_env")).toEqual([]);
    });

    test("the agent's own value wins; a workspace value needs a grant", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      await saved(workspaceId, null, "BOTH_SET", "workspace");
      const own = await saved(workspaceId, agentId, "BOTH_SET", "agent");
      const wsOnly = await saved(workspaceId, null, "WS_ONLY", "from-ws");
      await grant(workspaceId, "WS_ONLY", [agentId]);
      await grant(workspaceId, "BOTH_SET", [agentId]);

      const sessionId = await accepted(workspaceId, releaseId, [
        "WS_ONLY",
        "BOTH_SET",
      ]);
      expect(await envStartOf(sessionId)).toEqual({
        entries: [
          {
            name: "BOTH_SET",
            scope: "agent",
            kind: "plain",
            version: own.version,
            value: "agent",
          },
          {
            name: "WS_ONLY",
            scope: "workspace",
            kind: "plain",
            version: wsOnly.version,
            value: "from-ws",
          },
        ],
        skipped: [],
        captured_at: expect.any(String),
      });

      const [receipt] = await receiptsOf(workspaceId, "resolve_session_env");
      expect(receipt?.result).toEqual({
        entries: [
          {
            name: "BOTH_SET",
            scope: "agent",
            kind: "plain",
            version: own.version,
          },
          {
            name: "WS_ONLY",
            scope: "workspace",
            kind: "plain",
            version: wsOnly.version,
          },
        ],
        skipped: [],
      });
      expect(JSON.stringify(receipt)).not.toContain("from-ws");
    });

    test("a workspace value no grant reaches is refused, and grant_all reaches every agent", async () => {
      const workspaceId = await workspace();
      const { releaseId } = await agentOn(workspaceId);
      await saved(workspaceId, null, "NOT_GRANTED", "v");
      expect(
        await accept(workspaceId, releaseId, ["NOT_GRANTED"]),
      ).toMatchObject({ outcome: "variables_refused", reason: "not_granted" });

      await grant(workspaceId, "NOT_GRANTED", [], true);
      expect(
        await accept(workspaceId, releaseId, ["NOT_GRANTED"]),
      ).toMatchObject({ outcome: "accepted" });
    });

    test("a refusal creates no session and writes one receipt that names no variable", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      const result = await accept(workspaceId, releaseId, [
        "NO_VALUE_ANYWHERE",
      ]);
      expect(result).toMatchObject({
        outcome: "variables_refused",
        reason: "unresolved",
      });
      expect(
        await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(eq(sessions.ownerId, workspaceId)),
      ).toEqual([]);
      const rejected = await receiptsOf(workspaceId, "reject_session_env");
      expect(rejected).toHaveLength(1);
      expect(rejected[0]).toMatchObject({
        status: "failed",
        result: {
          reason: "unresolved",
          agent_id: agentId,
          release_id: releaseId,
        },
      });
      expect(JSON.stringify(rejected[0])).not.toContain("NO_VALUE_ANYWHERE");
    });

    test("a reserved name and an over-large total are refused", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      expect(await accept(workspaceId, releaseId, ["PATH"])).toMatchObject({
        outcome: "variables_refused",
        reason: "reserved_name",
      });
      // Three 48 KB values are 144 KB, over the session's 128 KB.
      for (const name of ["BIG_ONE", "BIG_TWO", "BIG_THREE"]) {
        await saved(workspaceId, agentId, name, "x".repeat(48 * 1024));
      }
      expect(
        await accept(workspaceId, releaseId, [
          "BIG_ONE",
          "BIG_TWO",
          "BIG_THREE",
        ]),
      ).toMatchObject({ outcome: "variables_refused", reason: "too_large" });
      expect(
        await accept(workspaceId, releaseId, ["BIG_ONE", "BIG_TWO"]),
      ).toMatchObject({ outcome: "accepted" });
    });

    test("an idempotent replay returns the stored session after the variable was deleted", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      const created = await saved(workspaceId, agentId, "GONE_SOON", "kept");
      const key = randomUUID();
      const first = await accept(workspaceId, releaseId, ["GONE_SOON"], key);
      if (first.outcome !== "accepted") throw new Error(first.outcome);
      await store().delete({
        principal: principal(workspaceId),
        scope: { workspaceId, agentId },
        name: "GONE_SOON",
        ifMatch: created.version,
      });
      const replay = await accept(workspaceId, releaseId, ["GONE_SOON"], key);
      expect(replay).toEqual({ outcome: "replayed", response: first.response });
      // The copy outlived the original.
      expect(await envStartOf(first.response.session_id)).toMatchObject({
        entries: [{ name: "GONE_SOON", value: "kept" }],
      });
      // A new key meets the missing variable.
      expect(await accept(workspaceId, releaseId, ["GONE_SOON"])).toMatchObject(
        { outcome: "variables_refused" },
      );
    });

    test("editing a value does not change what a running session took", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      const created = await saved(workspaceId, agentId, "EDITED_ONE", "old");
      const sessionId = await accepted(workspaceId, releaseId, ["EDITED_ONE"]);
      await put(workspaceId, agentId, "EDITED_ONE", "new", {
        ifMatch: created.version,
      });
      expect(await envStartOf(sessionId)).toMatchObject({
        entries: [{ name: "EDITED_ONE", value: "old" }],
      });
      const next = await accepted(workspaceId, releaseId, ["EDITED_ONE"]);
      expect(await envStartOf(next)).toMatchObject({
        entries: [{ name: "EDITED_ONE", value: "new" }],
      });
    });

    test("a secret enters the snapshot as a name and a version, never a value", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      const id = randomUUID();
      await db.insert(envVariables).values({
        id,
        workspaceId,
        agentId,
        name: "SECRET_ONE",
        kind: "secret",
        value: null,
        engineDelivery: true,
      });
      const sessionId = await accepted(workspaceId, releaseId, ["SECRET_ONE"]);
      const start = (await envStartOf(sessionId)) as {
        entries: { name: string; kind: string; value?: string }[];
      };
      expect(start.entries).toHaveLength(1);
      expect(start.entries[0]).toMatchObject({
        name: "SECRET_ONE",
        kind: "secret",
      });
      expect(start.entries[0]).not.toHaveProperty("value");
      // Without the delivery mark it is stored and goes nowhere.
      await db
        .update(envVariables)
        .set({ engineDelivery: false })
        .where(eq(envVariables.id, id));
      expect(
        await accept(workspaceId, releaseId, ["SECRET_ONE"]),
      ).toMatchObject({ outcome: "variables_refused", reason: "unresolved" });
    });
  });

  describe("when a session closes", () => {
    test("the copied values go with it and the names and versions stay", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      const created = await saved(workspaceId, agentId, "CLOSE_ME", "private");
      const sessionId = await accepted(workspaceId, releaseId, ["CLOSE_ME"]);

      // Paused keeps its copy: the session may resume.
      await db
        .update(sessions)
        .set({ admissionState: "paused" })
        .where(eq(sessions.id, sessionId));
      expect(await envStartOf(sessionId)).toMatchObject({
        entries: [{ name: "CLOSE_ME", value: "private" }],
      });

      await db
        .update(sessions)
        .set({ admissionState: "closed" })
        .where(eq(sessions.id, sessionId));
      expect(await envStartOf(sessionId)).toEqual({
        entries: [
          {
            name: "CLOSE_ME",
            scope: "agent",
            kind: "plain",
            version: created.version,
          },
        ],
        skipped: [],
        captured_at: expect.any(String),
      });
    });

    test("a session without a snapshot closes as before", async () => {
      const workspaceId = await workspace();
      const { releaseId } = await agentOn(workspaceId);
      const sessionId = await accepted(workspaceId, releaseId, undefined);
      await db
        .update(sessions)
        .set({ admissionState: "closed" })
        .where(eq(sessions.id, sessionId));
      expect(await envStartOf(sessionId)).toBeNull();
    });
  });

  describe("the claim", () => {
    type Launch = Awaited<ReturnType<typeof launchSession>>;
    // A given launch is a worker retrying the claim it already made.
    // A worker that announced `user_env`, unless it says it did not.
    async function claim(sessionId: string, again?: Launch, userEnv = true) {
      const launch = again ?? (await launchSession(db, { sessionId }));
      return createPostgresWorkerUnitOfWork(db).claimAtomic({
        ...(userEnv ? { userEnv: true as const } : {}),
        settingsGeneration: Number.MAX_SAFE_INTEGER,
        unsettledRepositoryIds: new Set(),
        unsettledConnectionIds: new Set(),
        runnable: testClaimCatalog(),
        costLimitUsd: 1_000,
        tokenLimit: null,
        nonceHash: hashWorkerToken(launch.nonce),
        executionId: launch.executionId,
        executionGeneration: launch.generation,
        attemptId: `att_${randomUUID()}`,
        credentialHash: hashWorkerToken(`tok-${randomUUID()}`),
        credentialTtlMs: 60_000,
        egress: {
          providerHash: hashWorkerToken(`wep-${randomUUID()}`),
          repositoryHash: hashWorkerToken(`wer-${randomUUID()}`),
          objectStoreHash: hashWorkerToken(`weo-${randomUUID()}`),
          bindingsOf: () => ({
            provider: "provider",
            repository: "repository",
            object_store: "sessions/s/",
          }),
        },
        leaseTtlMs: 60_000,
        now: new Date(),
      });
    }

    test("a session with no snapshot claims as before", async () => {
      const workspaceId = await workspace();
      const { releaseId } = await agentOn(workspaceId);
      const sessionId = await accepted(workspaceId, releaseId, undefined);
      expect((await claim(sessionId)).outcome).toBe("claimed");
    });

    test("the claim carries the snapshot's plain values, only to a worker that announced user_env", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      await saved(workspaceId, agentId, "CARRIED_ONE", "carried");
      const sessionId = await accepted(workspaceId, releaseId, ["CARRIED_ONE"]);
      const launch = await launchSession(db, { sessionId });
      // An old worker is told so, and nothing is bound or written.
      const before = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      expect((await claim(sessionId, launch, false)).outcome).toBe(
        "user_env_unsupported",
      );
      const after = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      expect(after).toEqual(before);
      expect(after[0]?.podId).toBeNull();
      // The same launch, now by a worker that carries them.
      const claimed = await claim(sessionId, launch);
      expect(claimed.outcome).toBe("claimed");
      if (claimed.outcome === "claimed") {
        expect(claimed.binding.env).toEqual({ CARRIED_ONE: "carried" });
      }
    }, 60_000);

    test("a session without variables binds with no env, and an old worker may claim it", async () => {
      const workspaceId = await workspace();
      const { releaseId } = await agentOn(workspaceId);
      const sessionId = await accepted(workspaceId, releaseId, undefined);
      const claimed = await claim(sessionId, undefined, false);
      expect(claimed.outcome).toBe("claimed");
      if (claimed.outcome === "claimed") {
        expect(Object.keys(claimed.binding)).not.toContain("env");
      }
    }, 60_000);

    test("a retry of a claim is judged the same way: an old worker is refused before anything rotates", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      await saved(workspaceId, agentId, "REPLAYED_ONE", "again");
      const sessionId = await accepted(workspaceId, releaseId, [
        "REPLAYED_ONE",
      ]);
      const launch = await launchSession(db, { sessionId });
      expect((await claim(sessionId, launch)).outcome).toBe("claimed");
      expect((await claim(sessionId, launch, false)).outcome).toBe(
        "user_env_unsupported",
      );
      const replayed = await claim(sessionId, launch);
      expect(replayed.outcome).toBe("replayed");
      if (replayed.outcome === "replayed") {
        expect(replayed.binding.env).toEqual({ REPLAYED_ONE: "again" });
      }
    }, 60_000);

    test("a snapshot of allowed names claims", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      await saved(workspaceId, agentId, "CLAIM_OK", "v");
      const sessionId = await accepted(workspaceId, releaseId, ["CLAIM_OK"]);
      expect((await claim(sessionId)).outcome).toBe("claimed");
    });

    const stored = (over: Record<string, unknown> = {}) => ({
      entries: [
        {
          name: "NODE_OPTIONS",
          scope: "agent",
          kind: "plain",
          version: 1,
          value: "--require /tmp/x.js",
        },
      ],
      skipped: [],
      captured_at: new Date().toISOString(),
      ...over,
    });

    async function setSnapshot(sessionId: string, envStart: unknown) {
      await db
        .update(sessions)
        .set({ envStart })
        .where(eq(sessions.id, sessionId));
    }

    const refusalReceipts = async (workspaceId: string, sessionId: string) =>
      (await receiptsOf(workspaceId, "reject_session_env")).filter(
        (r) =>
          (r.targetRef as { session_id?: string }).session_id === sessionId,
      );

    test("a name the platform reserves by now fails the session, once, and leaves nothing half done", async () => {
      const workspaceId = await workspace();
      const { releaseId } = await agentOn(workspaceId);
      const sessionId = await accepted(workspaceId, releaseId, undefined);
      // As a snapshot taken before the name was reserved.
      await setSnapshot(sessionId, stored());
      const launch = await launchSession(db, { sessionId });

      expect(await claim(sessionId, launch)).toEqual({
        outcome: "variables_refused",
      });

      const [row] = await db
        .select({ status: sessions.status, podId: sessions.podId })
        .from(sessions)
        .where(eq(sessions.id, sessionId));
      expect(row).toEqual({ status: "failed", podId: null });
      // The queued input is failed with it, not left to be delivered.
      const turnRows = await db
        .select({ status: turns.status, reason: turns.terminalReason })
        .from(turns)
        .where(eq(turns.sessionId, sessionId));
      expect(turnRows).toEqual([
        { status: "failed", reason: "variables_refused" },
      ]);
      expect(await db.select().from(queueMessages)).toEqual(
        (await db.select().from(queueMessages)).filter(
          (m) => m.sessionId !== sessionId,
        ),
      );
      expect(
        await db
          .select({ id: attempts.id })
          .from(attempts)
          .where(eq(attempts.sessionId, sessionId)),
      ).toEqual([]);
      const [given] = await db
        .select({
          failures: workerLaunches.launchFailureCount,
          nonceHash: workerLaunches.nonceHash,
        })
        .from(workerLaunches)
        .where(eq(workerLaunches.executionId, launch.executionId));
      expect(given).toEqual({ failures: 1, nonceHash: null });
      const [execution] = await db
        .select({ desired: executions.desiredState })
        .from(executions)
        .where(eq(executions.id, launch.executionId));
      expect(execution?.desired).toBe("terminated");

      const rejected = await refusalReceipts(workspaceId, sessionId);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.result).toEqual({ reason: "reserved_name" });
      expect(JSON.stringify(rejected[0])).not.toContain("NODE_OPTIONS");
      expect(JSON.stringify(rejected[0])).not.toContain("--require");

      // The same worker asking again gets no binding and writes nothing more.
      expect((await claim(sessionId, launch)).outcome).not.toBe("claimed");
      expect(await refusalReceipts(workspaceId, sessionId)).toHaveLength(1);
    });

    test("a retry of a claim whose answer was lost is judged again", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      await saved(workspaceId, agentId, "REPLAY_OK", "v");
      const sessionId = await accepted(workspaceId, releaseId, ["REPLAY_OK"]);
      const launch = await launchSession(db, { sessionId });
      expect((await claim(sessionId, launch)).outcome).toBe("claimed");
      // A replica that has since reserved the name gets the retry.
      await setSnapshot(
        sessionId,
        stored({
          entries: [
            {
              name: "BASH_ENV",
              scope: "agent",
              kind: "plain",
              version: 1,
              value: "/tmp/x",
            },
          ],
        }),
      );
      expect(await claim(sessionId, launch)).toEqual({
        outcome: "variables_refused",
      });
      expect(await refusalReceipts(workspaceId, sessionId)).toHaveLength(1);
    });

    test("a refused retry also ends the attempt the first answer started", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      await saved(workspaceId, agentId, "REPLAY_FENCE", "v");
      const sessionId = await accepted(workspaceId, releaseId, [
        "REPLAY_FENCE",
      ]);
      const launch = await launchSession(db, { sessionId });
      expect((await claim(sessionId, launch)).outcome).toBe("claimed");
      const before = (
        await db.select().from(sessions).where(eq(sessions.id, sessionId))
      )[0];
      await setSnapshot(
        sessionId,
        stored({
          entries: [
            {
              name: "BASH_ENV",
              scope: "agent",
              kind: "plain",
              version: 1,
              value: "/tmp/x",
            },
          ],
        }),
      );
      expect(await claim(sessionId, launch)).toEqual({
        outcome: "variables_refused",
      });

      const [attempt] = await db
        .select()
        .from(attempts)
        .where(eq(attempts.sessionId, sessionId));
      expect(attempt?.state).toBe("exited");
      const live = await pool.query(
        "SELECT count(*)::int AS n FROM worker_credentials WHERE attempt_id = $1 AND revoked_at IS NULL",
        [attempt?.id],
      );
      expect(live.rows[0]?.n).toBe(0);
      const after = (
        await db.select().from(sessions).where(eq(sessions.id, sessionId))
      )[0];
      expect(after?.leaseEpoch).toBe((before?.leaseEpoch ?? 0) + 1);
      expect(after?.authRevision).toBe((before?.authRevision ?? 0) + 1);
    });

    test("a snapshot that outlived its retention is refused at the claim", async () => {
      const workspaceId = await workspace();
      const { releaseId } = await agentOn(workspaceId);
      const sessionId = await accepted(workspaceId, releaseId, undefined);
      const old = new Date(Date.now() - ENV_START_RETENTION_MS - 60_000);
      await setSnapshot(
        sessionId,
        stored({
          entries: [
            {
              name: "OLD_ONE",
              scope: "agent",
              kind: "plain",
              version: 1,
              value: "v",
            },
          ],
          captured_at: old.toISOString(),
        }),
      );
      expect(await claim(sessionId)).toEqual({ outcome: "variables_refused" });
      const [receipt] = await refusalReceipts(workspaceId, sessionId);
      expect(receipt?.result).toEqual({ reason: "unresolved" });
    });

    test("a snapshot that is not the shape the accept writes is refused, not run", async () => {
      const workspaceId = await workspace();
      const { releaseId } = await agentOn(workspaceId);
      const sessionId = await accepted(workspaceId, releaseId, undefined);
      await setSnapshot(sessionId, {
        entries: [{ name: "A_ONE", kind: "secret", value: "kept-by-mistake" }],
      });
      expect(await claim(sessionId)).toEqual({ outcome: "variables_refused" });
    });
  });

  describe("retention", () => {
    test("a malformed snapshot neither blocks a close nor keeps a value past it", async () => {
      const workspaceId = await workspace();
      const { releaseId } = await agentOn(workspaceId);
      const shapes = [
        { entries: ["bad"] },
        { entries: { value: "kept-by-mistake" } },
        "scalar",
      ];
      for (const shape of shapes) {
        const sessionId = await accepted(workspaceId, releaseId, undefined);
        await db
          .update(sessions)
          .set({ envStart: shape })
          .where(eq(sessions.id, sessionId));
        await db
          .update(sessions)
          .set({ admissionState: "closed" })
          .where(eq(sessions.id, sessionId));
        expect(await envStartOf(sessionId)).toBeNull();
      }
    });

    test("the purge drops the values of an expired open session and leaves the rest", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      await saved(workspaceId, agentId, "PURGE_ME", "private");
      const expired = await accepted(workspaceId, releaseId, ["PURGE_ME"]);
      const fresh = await accepted(workspaceId, releaseId, ["PURGE_ME"]);
      await db
        .update(sessions)
        .set({
          envStart: sql`jsonb_set(${sessions.envStart}, '{captured_at}', to_jsonb(${new Date(Date.now() - ENV_START_RETENTION_MS - 60_000).toISOString()}::text))`,
        })
        .where(eq(sessions.id, expired));

      // Other tests of this database leave expired sessions too, so the count
      // is not asserted, only what happened to these two.
      expect(await purgeExpiredEnvStart(db, { limit: 100 })).toBeGreaterThan(0);
      expect(await envStartOf(expired)).toMatchObject({
        entries: [{ name: "PURGE_ME" }],
      });
      expect(JSON.stringify(await envStartOf(expired))).not.toContain(
        "private",
      );
      expect(await envStartOf(fresh)).toMatchObject({
        entries: [{ name: "PURGE_ME", value: "private" }],
      });
      // Nothing left to do on a second pass.
      expect(await purgeExpiredEnvStart(db, { limit: 10 })).toBe(0);
    });

    test("a stamp that is not a date neither stops the purge nor keeps its value", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      await saved(workspaceId, agentId, "PURGE_BAD", "private-bad");
      await saved(workspaceId, agentId, "PURGE_OLD", "private-old");
      const bad = await accepted(workspaceId, releaseId, ["PURGE_BAD"]);
      const old = await accepted(workspaceId, releaseId, ["PURGE_OLD"]);
      const stamp = async (id: string, value: string) =>
        db
          .update(sessions)
          .set({
            envStart: sql`jsonb_set(${sessions.envStart}, '{captured_at}', to_jsonb(${value}::text))`,
          })
          .where(eq(sessions.id, id));
      await stamp(bad, "2026-99-99T00:00:00Z");
      await stamp(
        old,
        new Date(Date.now() - ENV_START_RETENTION_MS - 60_000).toISOString(),
      );

      await purgeExpiredEnvStart(db, { limit: 100 });
      expect(JSON.stringify(await envStartOf(bad))).not.toContain(
        "private-bad",
      );
      expect(JSON.stringify(await envStartOf(old))).not.toContain(
        "private-old",
      );
    });
  });

  describe("racing writes", () => {
    test("an accept waits for a value edit in flight and pins the edited value", async () => {
      const workspaceId = await workspace();
      const { agentId, releaseId } = await agentOn(workspaceId);
      const created = await saved(workspaceId, agentId, "RACE_VALUE", "old");

      const writer = await pool.connect();
      try {
        await writer.query("BEGIN");
        await writer.query(
          "UPDATE env_variables SET value = 'new', version = nextval('env_variable_versions_seq') WHERE id = (SELECT id FROM env_variables WHERE workspace_id = $1 AND name = 'RACE_VALUE')",
          [workspaceId],
        );
        let settled = false;
        const pending = accept(workspaceId, releaseId, ["RACE_VALUE"]).then(
          (result) => {
            settled = true;
            return result;
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        // The accept's FOR SHARE read is queued behind the writer's row lock.
        expect(settled).toBe(false);
        await writer.query("COMMIT");
        const result = await pending;
        if (result.outcome !== "accepted") throw new Error(result.outcome);
        const start = (await envStartOf(result.response.session_id)) as {
          entries: { value: string; version: number }[];
        };
        expect(start.entries[0]?.value).toBe("new");
        expect(start.entries[0]?.version).toBeGreaterThan(created.version);
      } finally {
        writer.release();
      }
    });
  });
});
