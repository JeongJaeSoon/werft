import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { scopesForRole } from "@werft-ai/contracts";
import { callerFor } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import {
  agentCallerLimits,
  agentReleases,
  agents,
  agentUsage,
  agentVersions,
  authzDecisions,
  workspaces,
} from "../schema.ts";
import { fixtureTeam } from "../testing/fixture-team.ts";
import {
  releaseSpecColumns,
  TEST_CONNECTION_ID,
} from "../testing/spec-pins.ts";
import { createPostgresCallerLimitGate } from "./agent-caller-limits.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("caller limit gate on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "caller_limit_gate_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  // A workspace-wide rule takes Bash away from an agent whose release loads it.
  async function bashDenied() {
    const workspaceId = randomUUID();
    const slug = `ws-${workspaceId.slice(0, 8)}`;
    await db.insert(workspaces).values({ id: workspaceId, slug, name: slug });
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
      card: { capabilities: { credential_refs: [] } },
      contentSha256: "a".repeat(64),
    });
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId,
      cardSha256: "a".repeat(64),
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: {},
      effectiveTools: { tools: ["Bash"], mcp: [] },
    });
    await db
      .update(agents)
      .set({
        status: "active",
        activeReleaseId: releaseId,
        activationRevision: 1,
      })
      .where(eq(agents.id, agentId));
    await db.insert(agentUsage).values({ agentId, workspaceId });
    await db.insert(agentCallerLimits).values({
      agentId,
      workspaceId,
      targetKind: "workspace",
      toolsDeny: ["Bash"],
    });
    const caller = callerFor(
      {
        kind: "user",
        id: randomUUID(),
        workspace_id: workspaceId,
        role: "member",
        scopes: [...scopesForRole("member")],
      },
      { kind: "web" },
      randomUUID(),
    );
    return {
      workspaceId,
      agentId,
      releaseId,
      userId: caller.actor?.userId ?? null,
      channelId: null,
      subject: caller.subject,
      requestId: caller.requestId,
      githubPolicySource: "release",
      repositoryIds: [],
    };
  }

  const refusalsIn = (workspaceId: string) =>
    db
      .select({ id: authzDecisions.id })
      .from(authzDecisions)
      .where(
        and(
          eq(authzDecisions.ownerId, workspaceId),
          eq(authzDecisions.reasonCode, "caller_limited"),
        ),
      );

  test("a refused start writes its decision row and warns nothing", async () => {
    const input = await bashDenied();
    const warned: unknown[] = [];
    const gate = createPostgresCallerLimitGate(db, {
      warn: (...args) => warned.push(args),
    });

    expect(await gate.startRefusal(input)).toBe("tool");
    expect(await refusalsIn(input.workspaceId)).toHaveLength(1);
    expect(warned).toEqual([]);
  });

  test("a refusal whose decision row cannot be written is still a refusal, and says so in the log", async () => {
    const input = await bashDenied();
    const warned: [string, Record<string, unknown> | undefined][] = [];
    const gate = createPostgresCallerLimitGate(db, {
      warn: (message, fields) => warned.push([message, fields]),
    });

    // A real failed insert, whose error message carries the row's values.
    await db.execute(
      sql`ALTER TABLE authz_decisions RENAME TO authz_decisions_away`,
    );
    let refused: string | null;
    try {
      refused = await gate.startRefusal(input);
    } finally {
      await db.execute(
        sql`ALTER TABLE authz_decisions_away RENAME TO authz_decisions`,
      );
    }

    expect(refused).toBe("tool");
    expect(await refusalsIn(input.workspaceId)).toHaveLength(0);
    const principalId = input.subject.principal?.id ?? "";
    expect(principalId).not.toBe("");
    expect(JSON.stringify(warned)).not.toContain(principalId);
    expect(warned).toEqual([
      [
        "Caller limit refusal could not be recorded",
        {
          workspace_id: input.workspaceId,
          agent_id: input.agentId,
          release_id: input.releaseId,
          request_id: input.requestId,
          dimension: "tool",
          // drizzle's DrizzleQueryError keeps Error's name.
          error_name: "Error",
        },
      ],
    ]);
  });
});
