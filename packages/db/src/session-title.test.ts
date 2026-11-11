import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { normalizeSessionTitle } from "@werft-ai/contracts";
import {
  createAuthorizationPolicy,
  createSessionService,
  deriveSessionTitle,
  type SessionCatalog,
  SessionServiceError,
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
import {
  attempts,
  memberships,
  sessions,
  turns,
  users,
  workspaces,
} from "./schema.ts";
import { createPostgresSessionTitleStore } from "./session-titles.ts";
import {
  fixtureRelease,
  TEST_CONNECTION_ID,
  TEST_MODEL,
  testSessionCatalog,
} from "./testing/spec-pins.ts";
import { createPostgresUsageReader } from "./usage-reader.ts";
import { createPostgresWorkerUnitOfWork } from "./worker-unit-of-work.ts";

const OWNER = testCaller("00000000-0000-4000-8000-00000000000a");
const OTHER = testCaller("00000000-0000-4000-8000-00000000000b");

const CATALOG: SessionCatalog = testSessionCatalog({
  repositories: {
    app: {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});

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
    catalog: CATALOG,
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
  });

// As the service's create stores it: the store is what is under test.
async function create(body: { message: string; title?: string }) {
  const created = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    principal: OWNER,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    title:
      body.title === undefined
        ? deriveSessionTitle(body.message)
        : normalizeSessionTitle(body.title),
    titleSource: body.title === undefined ? "derived" : "user",
    repository: {
      id: "app",
      url: "https://example.invalid/app.git",
      branch: "main",
    },
    agentReleaseId: await fixtureRelease(db),
    model: TEST_MODEL,
    message: body.message,
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
  });
  if (created.outcome !== "accepted") throw new Error(created.outcome);
  return created.response.session_id;
}

async function statusEvents(sessionId: string) {
  const page = await service().readEvents(OWNER, sessionId, {
    limit: 100,
    maxBytes: 1_000_000,
  });
  return page.items.filter((item) => item.event === "status");
}

describe("session titles (94S-804)", () => {
  test("a given title and a derived one reach the list and the detail", async () => {
    const named = await create({ message: "hello", title: " Named\n one " });
    const derived = await create({
      message: "Fix the\n\nflaky   checkout test",
    });
    const blank = await create({ message: " \n " });

    expect((await service().getSession(OWNER, named)).title).toBe("Named one");
    expect((await service().getSession(OWNER, derived)).title).toBe(
      "Fix the flaky checkout test",
    );
    expect((await service().getSession(OWNER, blank)).title).toBeNull();

    const page = await service().listSessions(OWNER, { limit: 10 });
    expect(
      Object.fromEntries(page.items.map((item) => [item.id, item.title])),
    ).toEqual({
      [named]: "Named one",
      [derived]: "Fix the flaky checkout test",
      [blank]: null,
    });
  });

  test("a row from before the column reads null", async () => {
    const id = await create({ message: "hello" });
    await db.update(sessions).set({ title: null }).where(eq(sessions.id, id));
    expect((await service().getSession(OWNER, id)).title).toBeNull();
  });

  test("rename stores the title, keeps the revision and writes a status event carrying it", async () => {
    const id = await create({ message: "hello" });
    const before = await service().getSession(OWNER, id);
    const eventsBefore = (await statusEvents(id)).length;

    const renamed = await service().renameSession(OWNER, id, {
      title: "  Better\nname ",
    });
    expect(renamed.title).toBe("Better name");
    expect(renamed.revision).toBe(before.revision);
    expect((await service().getSession(OWNER, id)).title).toBe("Better name");

    const after = await statusEvents(id);
    expect(after).toHaveLength(eventsBefore + 1);
    expect(after.at(-1)?.data.data).toMatchObject({
      phase: before.status,
      admission_state: "active",
      title: "Better name",
    });
  });

  test("renaming to the same title writes no event", async () => {
    const id = await create({ message: "hello", title: "Same" });
    const count = (await statusEvents(id)).length;
    await service().renameSession(OWNER, id, { title: "Same" });
    expect(await statusEvents(id)).toHaveLength(count);
  });

  test("a member offboarded after the check renames nothing", async () => {
    const workspaceId = crypto.randomUUID();
    const userId = crypto.randomUUID();
    await db
      .insert(workspaces)
      .values({ id: workspaceId, slug: `ws-${workspaceId}`, name: "Acme" });
    await db.insert(users).values({
      id: userId,
      email: `${userId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "member",
    });
    await db
      .insert(memberships)
      .values({ workspaceId, userId, role: "member" });
    const principal = {
      ownerId: workspaceId,
      actor: {
        principal: { kind: "user" as const, id: userId },
        userId,
        workspaceId,
        apiKeyId: null,
      },
    };
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: workspaceId,
      workspaceId,
      createdByUserId: userId,
      repositoryMode: "none",
      title: "Before",
    });
    const controls = createPostgresSessionControl(db);
    const rename = () =>
      controls.renameAtomic({
        principal,
        sessionId: id,
        title: "After",
        now: new Date(),
      });

    await db
      .update(memberships)
      .set({ disabledAt: new Date() })
      .where(eq(memberships.userId, userId));
    expect(await rename()).toEqual({ outcome: "actor_inactive" });
    const [row] = await db
      .select({ title: sessions.title })
      .from(sessions)
      .where(eq(sessions.id, id));
    expect(row?.title).toBe("Before");

    await db
      .update(memberships)
      .set({ disabledAt: null })
      .where(eq(memberships.userId, userId));
    expect(await rename()).toEqual({ outcome: "renamed", changed: true });
  });

  test("another owner's session is not found", async () => {
    const id = await create({ message: "hello" });
    const refused = await service()
      .renameSession(OTHER, id, { title: "Mine now" })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(SessionServiceError);
    expect((refused as SessionServiceError).code).toBe("NOT_FOUND");
    expect((await service().getSession(OWNER, id)).title).toBe("hello");
  });
});

describe("generated titles (94S-1005)", () => {
  const titles = () => createPostgresSessionTitleStore(db);
  const hash = (seed: string) => new TextEncoder().encode(seed.padEnd(32, "x"));

  // The first turn completed on an attempt of its own, as finalize leaves it.
  async function firstTurnDone(body: { message: string; title?: string }) {
    const sessionId = await create(body);
    const attemptId = `attempt-${crypto.randomUUID()}`;
    await db.insert(attempts).values({
      id: attemptId,
      sessionId,
      executionId: `exec-${attemptId}`,
      leaseEpoch: 0,
      executionGeneration: 0,
      authRevision: 0,
      state: "running",
      leaseExpiresAt: new Date(Date.now() + 600_000),
    });
    await db
      .update(turns)
      .set({
        status: "completed",
        attemptId,
        resultJson: { result: "Fixed it." },
      })
      .where(and(eq(turns.sessionId, sessionId), eq(turns.sequence, 1)));
    return { sessionId, attemptId };
  }

  async function titleRow(sessionId: string) {
    const [row] = await db
      .select({ title: sessions.title, source: sessions.titleSource })
      .from(sessions)
      .where(eq(sessions.id, sessionId));
    return row;
  }

  test("create records whether the title was given", async () => {
    const given = await create({ message: "hello", title: "Mine" });
    const derived = await create({ message: "hello" });
    expect(await titleRow(given)).toEqual({ title: "Mine", source: "user" });
    expect(await titleRow(derived)).toEqual({
      title: "hello",
      source: "derived",
    });
  });

  test("a derived title is replaced once, with a status event carrying it", async () => {
    const { sessionId, attemptId } = await firstTurnDone({
      message: "fix the flaky test",
    });
    const issued = await titles().issueAtomic({
      sessionId,
      attemptId,
      tokenHash: hash("a"),
      ttlMs: 60_000,
    });
    expect(issued).toMatchObject({
      outcome: "issued",
      message: "fix the flaky test",
      result: "Fixed it.",
      connectionId: TEST_CONNECTION_ID,
      model: TEST_MODEL,
    });
    const authorized = await titles().authorizeAtomic({ tokenHash: hash("a") });
    expect(authorized).toMatchObject({ outcome: "ok", sessionId, attemptId });
    // Used up by that grant: a second exchange on the same token is refused.
    expect(await titles().authorizeAtomic({ tokenHash: hash("a") })).toEqual({
      outcome: "invalid_token",
    });

    const eventsBefore = (await statusEvents(sessionId)).length;
    expect(
      await titles().settleAtomic({
        tokenHash: hash("a"),
        title: "Flaky test fix",
        now: new Date(),
      }),
    ).toEqual({ outcome: "applied" });
    expect(await titleRow(sessionId)).toEqual({
      title: "Flaky test fix",
      source: "generated",
    });
    const events = await statusEvents(sessionId);
    expect(events).toHaveLength(eventsBefore + 1);
    expect(events.at(-1)?.data.data).toMatchObject({ title: "Flaky test fix" });

    // Settled: the token no longer authorizes, and no second request is made.
    expect(await titles().authorizeAtomic({ tokenHash: hash("a") })).toEqual({
      outcome: "invalid_token",
    });
    expect(
      await titles().issueAtomic({
        sessionId,
        attemptId,
        tokenHash: hash("b"),
        ttlMs: 60_000,
      }),
    ).toEqual({ outcome: "skipped" });
  });

  test("a title the user gave is never asked about", async () => {
    const { sessionId, attemptId } = await firstTurnDone({
      message: "hello",
      title: "Mine",
    });
    expect(
      await titles().issueAtomic({
        sessionId,
        attemptId,
        tokenHash: hash("c"),
        ttlMs: 60_000,
      }),
    ).toEqual({ outcome: "skipped" });
  });

  test("a rename that lands while the title is being generated wins", async () => {
    const { sessionId, attemptId } = await firstTurnDone({ message: "hello" });
    await titles().issueAtomic({
      sessionId,
      attemptId,
      tokenHash: hash("d"),
      ttlMs: 60_000,
    });
    await service().renameSession(OWNER, sessionId, { title: "Chosen" });
    expect(
      await titles().settleAtomic({
        tokenHash: hash("d"),
        title: "Generated",
        now: new Date(),
      }),
    ).toEqual({ outcome: "kept" });
    expect(await titleRow(sessionId)).toEqual({
      title: "Chosen",
      source: "user",
    });
  });

  test("a rename to the title it already has still keeps it the user's", async () => {
    const { sessionId, attemptId } = await firstTurnDone({ message: "hello" });
    await titles().issueAtomic({
      sessionId,
      attemptId,
      tokenHash: hash("e"),
      ttlMs: 60_000,
    });
    await service().renameSession(OWNER, sessionId, { title: "hello" });
    await titles().settleAtomic({
      tokenHash: hash("e"),
      title: "Generated",
      now: new Date(),
    });
    expect(await titleRow(sessionId)).toEqual({
      title: "hello",
      source: "user",
    });
  });

  test("a title changed by an API from before title_source is not replaced", async () => {
    const { sessionId, attemptId } = await firstTurnDone({ message: "hello" });
    await titles().issueAtomic({
      sessionId,
      attemptId,
      tokenHash: hash("j"),
      ttlMs: 60_000,
    });
    // What an older replica's rename writes: the title, not its source.
    await db
      .update(sessions)
      .set({ title: "Renamed elsewhere" })
      .where(eq(sessions.id, sessionId));
    expect(
      await titles().settleAtomic({
        tokenHash: hash("j"),
        title: "Generated",
        now: new Date(),
      }),
    ).toEqual({ outcome: "kept" });
    expect(await titleRow(sessionId)).toEqual({
      title: "Renamed elsewhere",
      source: "derived",
    });
  });

  test("a title an older API renamed before the first turn ended is not asked about", async () => {
    const { sessionId, attemptId } = await firstTurnDone({ message: "hello" });
    await db
      .update(sessions)
      .set({ title: "Renamed early" })
      .where(eq(sessions.id, sessionId));
    expect(
      await titles().issueAtomic({
        sessionId,
        attemptId,
        tokenHash: hash("k"),
        ttlMs: 60_000,
      }),
    ).toEqual({ outcome: "skipped" });
  });

  test("a row an older API inserts is the user's", async () => {
    const id = crypto.randomUUID();
    await db.insert(sessions).values({
      id,
      ownerId: OWNER.ownerId,
      repositoryMode: "none",
      title: "Given",
    });
    expect(await titleRow(id)).toEqual({ title: "Given", source: "user" });
  });

  test("a failed call keeps the derived title", async () => {
    const { sessionId, attemptId } = await firstTurnDone({ message: "hello" });
    await titles().issueAtomic({
      sessionId,
      attemptId,
      tokenHash: hash("f"),
      ttlMs: 60_000,
    });
    expect(
      await titles().settleAtomic({
        tokenHash: hash("f"),
        title: null,
        now: new Date(),
      }),
    ).toEqual({ outcome: "kept" });
    expect(await titleRow(sessionId)).toEqual({
      title: "hello",
      source: "derived",
    });
  });

  test("only a completed first turn on the same attempt issues one", async () => {
    const { sessionId, attemptId } = await firstTurnDone({ message: "hello" });
    expect(
      await titles().issueAtomic({
        sessionId,
        attemptId: "attempt-other",
        tokenHash: hash("g"),
        ttlMs: 60_000,
      }),
    ).toEqual({ outcome: "skipped" });
    await db
      .update(turns)
      .set({ status: "failed" })
      .where(eq(turns.sessionId, sessionId));
    expect(
      await titles().issueAtomic({
        sessionId,
        attemptId,
        tokenHash: hash("g"),
        ttlMs: 60_000,
      }),
    ).toEqual({ outcome: "skipped" });
  });

  test("an expired request or a revoked session stops authorizing", async () => {
    const expired = await firstTurnDone({ message: "hello" });
    await titles().issueAtomic({
      ...expired,
      tokenHash: hash("h"),
      ttlMs: -1,
    });
    expect(await titles().authorizeAtomic({ tokenHash: hash("h") })).toEqual({
      outcome: "invalid_token",
    });

    const revoked = await firstTurnDone({ message: "hello" });
    await titles().issueAtomic({
      ...revoked,
      tokenHash: hash("i"),
      ttlMs: 60_000,
    });
    await db
      .update(sessions)
      .set({ authRevision: 1 })
      .where(eq(sessions.id, revoked.sessionId));
    expect(await titles().authorizeAtomic({ tokenHash: hash("i") })).toEqual({
      outcome: "invalid_token",
    });
  });

  test("the call's usage is the session's, on an attempt that has ended", async () => {
    const { sessionId, attemptId } = await firstTurnDone({ message: "hello" });
    await db
      .update(attempts)
      .set({ state: "exited" })
      .where(eq(attempts.id, attemptId));
    const recorded = await createPostgresWorkerUnitOfWork(
      db,
    ).recordProviderUsageAtomic({
      exchangeId: crypto.randomUUID(),
      sessionId,
      attemptId,
      usage: {
        model: "claude-haiku-4-5",
        inputTokens: 120,
        outputTokens: 8,
        cacheCreationInputTokens: 0,
        cacheCreation1hInputTokens: 0,
        cacheReadInputTokens: 0,
        speed: "standard",
        inferenceGeo: "global",
        webSearchRequests: 0,
        webFetchRequests: 0,
        codeExecutionRequests: 0,
        estimated: false,
      },
      priceFor: () => ({ costUsd: 0.000_2, pricedBy: "table" }),
    });
    expect(recorded.outcome).toBe("recorded");
    const usage = await createPostgresUsageReader(db).sessionUsage(
      OWNER.ownerId,
      sessionId,
    );
    expect(usage).toMatchObject({ costUsd: "0.000200", providerTokens: 128 });
  });
});
