import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import {
  agentReleases,
  agents,
  providerUsage,
  sessionModelUsage,
  sessions,
} from "../schema.ts";
import {
  releaseSpecColumns,
  TEST_CONNECTION_ID,
} from "../testing/spec-pins.ts";
import { createPostgresUsageReader } from "./usage-reader.ts";

// The breakdown's calls of unknown price under each row (94S-2581): the
// rows and totals carry them, a session outside the period does not count.
describe("calls of unknown price on the usage breakdown", () => {
  let client: PGlite;
  let db: Database;
  const owner = randomUUID();
  const agentA = randomUUID();
  const agentB = randomUUID();
  const period = {
    since: new Date("2026-10-20T00:00:00.000Z"),
    until: new Date("2026-10-22T00:00:00.000Z"),
  };
  const priced = "claude-sonnet-5";
  const unpriced = "verify-unpriced-model";

  async function session(agentId: string, createdAt: string) {
    const releaseId = `rel-${randomUUID()}`;
    await db.insert(agentReleases).values({
      id: releaseId,
      agentId,
      versionId: randomUUID(),
      cardSha256: "a".repeat(64),
      connectionId: TEST_CONNECTION_ID,
      ...releaseSpecColumns(),
      runtimeConfigSnapshot: {},
      effectiveTools: { tools: [], mcp: [] },
    });
    const id = randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: owner,
      repoUrl: "https://github.com/acme/app.git",
      branch: "main",
      repositoryId: "app",
      checkpointRevision: 1,
      agentReleaseId: releaseId,
      createdAt: new Date(createdAt),
    });
    return id;
  }

  // As the rollup trigger would sum them; the triggers are off here.
  async function calls(c: {
    sessionId: string;
    agentId: string;
    createdAt: string;
    model: string;
    tokens: number[];
    unknown: boolean;
  }) {
    for (const tokens of c.tokens) {
      await db.insert(providerUsage).values({
        exchangeId: randomUUID(),
        sessionId: c.sessionId,
        attemptId: `att-${randomUUID()}`,
        model: c.model,
        inputTokens: tokens,
        outputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        cacheReadInputTokens: 0,
        estimated: false,
        costUsd: c.unknown ? 0 : 0.000042,
        pricedBy: c.unknown ? "unknown" : "table",
        priceUnknown: c.unknown,
      });
    }
    await db.insert(sessionModelUsage).values({
      sessionId: c.sessionId,
      model: c.model,
      sessionCreatedAt: new Date(c.createdAt),
      agentId: c.agentId,
      inputTokens: c.tokens.reduce((sum, n) => sum + n, 0),
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUsd: c.unknown ? 0 : 0.000042 * c.tokens.length,
    });
  }

  beforeAll(async () => {
    client = await migratedPGlite();
    // Sessions, releases and calls stand alone here: no foreign keys or
    // triggers.
    await client.exec("SET session_replication_role = replica");
    db = drizzle(client, { schema }) as unknown as Database;
    for (const [id, name] of [
      [agentA, "Mixed Helper"],
      [agentB, "Unknown Helper"],
    ] as const) {
      await db.insert(agents).values({
        id,
        workspaceId: owner,
        managingTeamId: randomUUID(),
        slug: `a-${id.slice(0, 8)}`,
        name,
      });
    }
    const day = "2026-10-20T09:00:00Z";
    const mixed = await session(agentA, day);
    await calls({
      sessionId: mixed,
      agentId: agentA,
      createdAt: day,
      model: priced,
      tokens: [10, 20],
      unknown: false,
    });
    await calls({
      sessionId: mixed,
      agentId: agentA,
      createdAt: day,
      model: unpriced,
      tokens: [15, 30],
      unknown: true,
    });
    const onlyUnknown = await session(agentB, day);
    await calls({
      sessionId: onlyUnknown,
      agentId: agentB,
      createdAt: day,
      model: unpriced,
      tokens: [10],
      unknown: true,
    });
    const later = "2026-10-25T09:00:00Z";
    const outside = await session(agentB, later);
    await calls({
      sessionId: outside,
      agentId: agentB,
      createdAt: later,
      model: unpriced,
      tokens: [99],
      unknown: true,
    });
  });

  afterAll(async () => {
    await client.close();
  });

  const read = (by: "model" | "agent") =>
    createPostgresUsageReader(db).usageBreakdown(
      { kind: "installation" },
      period,
      by,
    );

  test("by model: the unpriced model's row holds its calls and tokens, the priced one none", async () => {
    const record = await read("model");
    expect(
      record.rows.map((row) => [row.key, row.unknownPrice, row.inputTokens]),
    ).toEqual(
      expect.arrayContaining([
        [priced, { callCount: 0, tokens: 0 }, 30],
        [unpriced, { callCount: 3, tokens: 55 }, 55],
      ]),
    );
    expect(record.rows).toHaveLength(2);
    expect(record.totals.unknownPrice).toEqual({ callCount: 3, tokens: 55 });
  });

  test("by agent: each agent's sessions' calls of unknown price, and the totals of both", async () => {
    const record = await read("agent");
    const byKey = new Map(record.rows.map((row) => [row.key, row]));
    expect(byKey.get(agentA)?.unknownPrice).toEqual({
      callCount: 2,
      tokens: 45,
    });
    expect(byKey.get(agentB)?.unknownPrice).toEqual({
      callCount: 1,
      tokens: 10,
    });
    expect(record.totals.unknownPrice).toEqual({ callCount: 3, tokens: 55 });
  });
});
