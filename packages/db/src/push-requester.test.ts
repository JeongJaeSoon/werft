import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import {
  pendingRequesterOf,
  pushRequesterOf,
} from "./musterrolle/session-shares.ts";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  pendingRequests,
  pushIntents,
  pushRequests,
  receipts,
  sessions,
  turns,
  users,
  workspaces,
} from "./schema.ts";

// Answer 15, second part (94S-2000): whose push a request is, for the
// private channel rule on a requester who left. The person of the turn that
// asked for it (that turn's root for a push follow-up), else the person who
// asked over the API, else whoever started the session.
describe("pushRequesterOf", () => {
  let client: PGlite;
  let db: Database;
  const ws = randomUUID();
  const sessionId = randomUUID();
  const starter = randomUUID();
  const people = {
    turn: randomUUID(),
    root: randomUUID(),
    api: randomUUID(),
  };
  let sequence = 0;

  beforeAll(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    await db.insert(workspaces).values({ id: ws, slug: "ws-push", name: "ws" });
    await db.insert(users).values({
      id: starter,
      email: `${starter}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "starter",
    });
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: ws,
      workspaceId: ws,
      repoUrl: "https://example.invalid/repo.git",
      branch: "main",
      createdByUserId: starter,
    });
  }, 60_000);

  afterAll(() => client.close());

  async function push(
    requestedBy: Record<string, unknown>,
    turn?: {
      requesterKind: string | null;
      requesterId: string | null;
      requesterAuth?: unknown;
    },
  ): Promise<string> {
    const receiptId = randomUUID();
    await db.insert(receipts).values({
      id: receiptId,
      ownerId: ws,
      operation: "request_push",
      targetRef: { session_id: sessionId, turn_id: null, request_id: null },
      actor: requestedBy,
    });
    const id = randomUUID();
    await db.insert(pushRequests).values({
      id,
      ownerId: ws,
      sessionId,
      // One open request per target: each its own repository.
      repositoryId: `repo-${id}`,
      checkpointRevision: 1,
      gitCommit: "a".repeat(40),
      targetBranch: `agent/${sessionId}`,
      requestedBy,
      requestReceiptId: receiptId,
      origin: turn === undefined ? "direct" : "intent",
    });
    if (turn !== undefined) {
      sequence += 1;
      const [row] = await db
        .insert(turns)
        .values({
          sessionId,
          sequence,
          message: "push it",
          status: "completed",
          requesterKind: turn.requesterKind,
          requesterId: turn.requesterId,
          requesterAuth: turn.requesterAuth ?? null,
        })
        .returning({ id: turns.id });
      await db.insert(pushIntents).values({
        id: randomUUID(),
        ownerId: ws,
        sessionId,
        turnId: row?.id ?? 0,
        attemptId: "attempt-1",
        repositoryId: `repo-${id}`,
        targetBranch: `agent/${sessionId}`,
        status: "requested",
        pinnedRevision: 1,
        pushRequestId: id,
        actor: { principal: { kind: "worker", id: "w" } },
      });
    }
    return id;
  }

  const of = (id: string, session = sessionId) =>
    pushRequesterOf(db, ws, session, id);

  test("a turn's person asked for it", async () => {
    expect(
      await of(
        await push(
          { principal: { kind: "worker", id: "w" } },
          { requesterKind: "user", requesterId: people.turn },
        ),
      ),
    ).toBe(people.turn);
  });

  test("a push follow-up's root person asked for it, not the agent", async () => {
    const auth = {
      method: "push_decision",
      push_request_id: randomUUID(),
      decision: "approve",
      root: {
        requester_kind: "user",
        requester_id: people.root,
        requester_auth: null,
        via: [],
      },
    };
    expect(
      await of(
        await push(
          { principal: { kind: "worker", id: "w" } },
          {
            requesterKind: "agent",
            requesterId: randomUUID(),
            requesterAuth: auth,
          },
        ),
      ),
    ).toBe(people.root);
  });

  test("a person over the API", async () => {
    expect(
      await of(
        await push({
          principal: { kind: "user", id: people.api },
          actor_user_id: people.api,
          agent_id: null,
        }),
      ),
    ).toBe(people.api);
  });

  test("no person behind it: whoever started the session", async () => {
    expect(
      await of(
        await push(
          { principal: { kind: "worker", id: "w" } },
          { requesterKind: "api_key", requesterId: randomUUID() },
        ),
      ),
    ).toBe(starter);
    expect(
      await of(
        await push({
          principal: { kind: "api_key", id: randomUUID() },
          actor_user_id: null,
          agent_id: null,
        }),
      ),
    ).toBe(starter);
  });

  test("after a takeover, a push with no person behind it is the new holder's", async () => {
    const holder = randomUUID();
    await db.insert(users).values({
      id: holder,
      email: `${holder}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "holder",
    });
    // takeOver moves created_by_user_id to whoever took the session over.
    await db
      .update(sessions)
      .set({ createdByUserId: holder })
      .where(eq(sessions.id, sessionId));
    try {
      expect(
        await of(
          await push(
            { principal: { kind: "worker", id: "w" } },
            { requesterKind: "api_key", requesterId: randomUUID() },
          ),
        ),
      ).toBe(holder);
      // A turn's person still comes first.
      expect(
        await of(
          await push(
            { principal: { kind: "worker", id: "w" } },
            { requesterKind: "user", requesterId: people.turn },
          ),
        ),
      ).toBe(people.turn);
    } finally {
      await db
        .update(sessions)
        .set({ createdByUserId: starter })
        .where(eq(sessions.id, sessionId));
    }
  });

  test("another session's request, or none, is no one's", async () => {
    const id = await push({ principal: { kind: "user", id: people.api } });
    expect(await of(id, randomUUID())).toBeNull();
    expect(await of(randomUUID())).toBeNull();
    expect(await of("not-a-uuid")).toBeNull();
  });
});

// Q5 (94S-2175): whose tool permission or question request is, by the same
// rule: the person of the turn that asked (its root for a push follow-up),
// else whoever started the session.
describe("pendingRequesterOf", () => {
  let client: PGlite;
  let db: Database;
  const ws = randomUUID();
  const sessionId = randomUUID();
  const starter = randomUUID();
  const people = { turn: randomUUID(), root: randomUUID() };
  let sequence = 0;

  beforeAll(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    await db
      .insert(workspaces)
      .values({ id: ws, slug: "ws-pending", name: "ws" });
    await db.insert(users).values({
      id: starter,
      email: `${starter}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "starter",
    });
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: ws,
      workspaceId: ws,
      repoUrl: "https://example.invalid/repo.git",
      branch: "main",
      createdByUserId: starter,
    });
  }, 60_000);

  afterAll(() => client.close());

  async function pending(turn: {
    requesterKind: string | null;
    requesterId: string | null;
    requesterAuth?: unknown;
  }): Promise<string> {
    sequence += 1;
    const [row] = await db
      .insert(turns)
      .values({
        sessionId,
        sequence,
        message: "run it",
        status: "running",
        requesterKind: turn.requesterKind,
        requesterId: turn.requesterId,
        requesterAuth: turn.requesterAuth ?? null,
      })
      .returning({ id: turns.id });
    const requestId = `toolu_${randomUUID()}`;
    await db.insert(pendingRequests).values({
      requestId,
      sessionId,
      turnId: row?.id ?? 0,
      attemptId: "attempt-1",
      kind: "permission",
      payload: { tool: "Bash", input: { command: "ls" } },
      inputHash: "h",
      expiresAt: new Date(Date.now() + 60_000),
    });
    return requestId;
  }

  const of = (id: string, session: string = sessionId) =>
    pendingRequesterOf(db, ws, session, id);

  test("the person of the turn that asked", async () => {
    expect(
      await of(
        await pending({ requesterKind: "user", requesterId: people.turn }),
      ),
    ).toBe(people.turn);
  });

  test("a push follow-up's root person, not the agent", async () => {
    expect(
      await of(
        await pending({
          requesterKind: "agent",
          requesterId: randomUUID(),
          requesterAuth: {
            method: "push_decision",
            push_request_id: randomUUID(),
            decision: "approve",
            root: {
              requester_kind: "user",
              requester_id: people.root,
              requester_auth: null,
              via: [],
            },
          },
        }),
      ),
    ).toBe(people.root);
  });

  test("no person behind the turn: whoever started the session", async () => {
    expect(
      await of(
        await pending({ requesterKind: "api_key", requesterId: randomUUID() }),
      ),
    ).toBe(starter);
    expect(
      await of(await pending({ requesterKind: null, requesterId: null })),
    ).toBe(starter);
  });

  test("another session's request, or none, is no one's", async () => {
    const id = await pending({
      requesterKind: "user",
      requesterId: people.turn,
    });
    expect(await of(id, randomUUID())).toBeNull();
    expect(await of("toolu_missing")).toBeNull();
    expect(await of(id, "not-a-uuid")).toBeNull();
  });
});
