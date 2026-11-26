import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { ListSessionsQuery } from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createSessionService,
  WORKER_OWNERSHIP_LOST_REASON,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createPostgresSessionControl } from "./control-unit-of-work.ts";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { sessions, turns } from "./schema.ts";
import {
  fixtureRelease,
  TEST_MODEL,
  testSessionCatalog,
} from "./testing/spec-pins.ts";

// The list's word for a session whose last turn a lost lease cut off
// (94S-2261), and the filter and count the console's tabs read it by.

const OWNER = testCaller("00000000-0000-4000-8000-00000000000c");
const LIMITS = { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 };

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

const service = () =>
  createSessionService({
    authorization: createAuthorizationPolicy(),
    inputs: createPostgresSessionUnitOfWork(db),
    controls: createPostgresSessionControl(db),
    reader: createPostgresSessionReader(db),
    catalog: testSessionCatalog({
      repositories: {
        app: {
          url: "https://example.invalid/app.git",
          branch: "main",
          auth: { kind: "github_app", registered: true },
        },
      },
    }),
    limits: {
      ...LIMITS,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
  });

/** A session whose turns ended as given, in order, and whose status is set. */
async function sessionWith(
  status: "idle" | "failed",
  ended: readonly ("lost" | "completed")[],
) {
  const inputs = createPostgresSessionUnitOfWork(db);
  const created = await inputs.acceptInputAtomic({
    principal: OWNER,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    repository: {
      id: "app",
      url: "https://example.invalid/app.git",
      branch: "main",
    },
    agentReleaseId: await fixtureRelease(db),
    model: TEST_MODEL,
    message: "turn 1",
    limits: LIMITS,
  });
  if (created.outcome !== "accepted") throw new Error(created.outcome);
  const sessionId = created.response.session_id;
  for (const [index, end] of ended.entries()) {
    if (index > 0) {
      const appended = await inputs.appendInputAtomic({
        principal: OWNER,
        sessionId,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: crypto.randomUUID(),
        message: `turn ${index + 1}`,
        limits: LIMITS,
      });
      if (appended.outcome !== "accepted") throw new Error(appended.outcome);
    }
    await db
      .update(turns)
      .set(
        end === "lost"
          ? { status: "failed", terminalReason: WORKER_OWNERSHIP_LOST_REASON }
          : { status: "completed" },
      )
      .where(
        and(eq(turns.sessionId, sessionId), eq(turns.sequence, index + 1)),
      );
  }
  await db.update(sessions).set({ status }).where(eq(sessions.id, sessionId));
  return sessionId;
}

async function listed(query: Partial<ListSessionsQuery> = {}) {
  const page = await service().listSessions(OWNER, { limit: 50, ...query });
  return page.items;
}

describe("a session whose last turn a lost lease cut off (94S-2261)", () => {
  test("the list says so for the last turn only, and the tabs' filter and count agree", async () => {
    const cutOff = await sessionWith("idle", ["lost"]);
    const goneOn = await sessionWith("idle", ["lost", "completed"]);
    const rested = await sessionWith("idle", ["completed"]);
    const failed = await sessionWith("failed", ["lost"]);

    const flags = Object.fromEntries(
      (await listed()).map((item) => [item.id, item.last_turn_cut_off]),
    );
    expect(flags).toEqual({
      [cutOff]: true,
      [goneOn]: false,
      [rested]: false,
      [failed]: true,
    });

    const ids = async (query: Partial<ListSessionsQuery>) =>
      (await listed(query)).map((item) => item.id).sort();
    const cutOffTab = await ids({ status: "idle", last_turn_cut_off: "true" });
    const idleTab = await ids({ status: "idle", last_turn_cut_off: "false" });
    expect(cutOffTab).toEqual([cutOff]);
    expect(idleTab).toEqual([goneOn, rested].sort());
    // status=idle keeps its meaning for an API client.
    expect(await ids({ status: "idle" })).toEqual(
      [cutOff, goneOn, rested].sort(),
    );
    expect(await ids({ last_turn_cut_off: "true" })).toEqual(
      [cutOff, failed].sort(),
    );

    const { counts, total } = await service().countSessions(OWNER, {});
    expect(counts.idle).toBe(3);
    expect(counts.failed).toBe(1);
    expect(total).toBe(4);
    // What the console's two tabs show, read from the counts as the web does.
    expect(counts.cut_off).toBe(cutOffTab.length);
    expect(counts.idle - counts.cut_off).toBe(idleTab.length);
  });
});
