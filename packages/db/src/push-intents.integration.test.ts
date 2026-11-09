import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ReceiptActor } from "@werft-ai/contracts";
import type {
  PushIntentStore,
  PushRequestStore,
  PushWriteResult,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresPushIntents } from "./push-intents.ts";
import { createPostgresPushRequests } from "./push-requests.ts";
import * as schema from "./schema.ts";
import { pushIntents, pushRequests, sessions, turns } from "./schema.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const OWNER = "owner-intents";
const COMMIT = "c".repeat(40);
const ACTOR: ReceiptActor = {
  principal: { kind: "api_key", id: "key-writer" },
  actor_user_id: null,
  agent_id: null,
};

function written(result: PushWriteResult) {
  if (result.outcome !== "written" && result.outcome !== "replayed") {
    throw new Error(`expected a write, got ${JSON.stringify(result)}`);
  }
  return result.request;
}

integration("push intents and the same-target rules on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let intents: PushIntentStore;
  let requests: PushRequestStore;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "push_intents_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
    intents = createPostgresPushIntents(db);
    requests = createPostgresPushRequests(db);
  });

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  async function runningTurn(checkpointRevision = 2, status = "running") {
    const sessionId = crypto.randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      ownerId: OWNER,
      repoUrl: "https://example.invalid/app.git",
      branch: "main",
      repositoryId: "sample-app",
      checkpointRevision,
    });
    const [turn] = await db
      .insert(turns)
      .values({
        sessionId,
        sequence: 1,
        message: "work",
        status,
        attemptId: "attempt-1",
      })
      .returning({ id: turns.id });
    if (!turn) throw new Error("no turn");
    return { sessionId, turnId: turn.id };
  }

  const ask = (
    s: { sessionId: string; turnId: number },
    branch?: string,
    extra: { repositoryId?: string; sourceRef?: string } = {},
  ) =>
    intents.createDeferred({
      ownerId: OWNER,
      sessionId: s.sessionId,
      turnId: s.turnId,
      attemptId: "attempt-1",
      repositoryId: extra.repositoryId ?? "sample-app",
      targetBranch: branch ?? `agent/${s.sessionId}`,
      actor: ACTOR,
      pushClass: "push.primary",
      policySource: "agent",
      ...(extra.sourceRef === undefined ? {} : { sourceRef: extra.sourceRef }),
    });

  const createRequest = (
    sessionId: string,
    over: Partial<Parameters<PushRequestStore["create"]>[0]> = {},
  ) =>
    requests.create({
      ownerId: OWNER,
      sessionId,
      actor: ACTOR,
      idempotencyKey: crypto.randomUUID(),
      payloadHash: "h",
      repositoryId: "sample-app",
      repositoryBinding: "sha256:binding",
      checkpointRevision: 2,
      gitCommit: COMMIT,
      policyApproval: null,
      policyFields: {},
      ...over,
    });

  test("the same turn and target return the same deferred intent", async () => {
    const s = await runningTurn();
    const first = await ask(s);
    if (first.outcome !== "created") throw new Error("expected created");
    expect(first.intent).toMatchObject({
      status: "deferred",
      refusal_code: null,
      push_request_id: null,
      target_branch: `agent/${s.sessionId}`,
    });
    const again = await ask(s);
    expect(again).toMatchObject({ outcome: "existing" });
    if (again.outcome !== "existing") throw new Error("unreachable");
    expect(again.intent.id).toBe(first.intent.id);
    expect(await intents.list(OWNER, s.sessionId)).toHaveLength(1);
    expect(await intents.list("someone-else", s.sessionId)).toHaveLength(0);
  });

  test("a turn that is no longer running takes no intent", async () => {
    const s = await runningTurn(2, "completed");
    expect(await ask(s)).toEqual({ outcome: "turn_not_running" });
    expect(await intents.list(OWNER, s.sessionId)).toHaveLength(0);
  });

  test("another target of the same turn without a source is refused: both would push the turn's one snapshot", async () => {
    const s = await runningTurn();
    await ask(s);
    expect(await ask(s, `agent/${s.sessionId}-docs`)).toEqual({
      outcome: "source_ref_required",
      targetBranch: `agent/${s.sessionId}`,
    });
    expect(await intents.list(OWNER, s.sessionId)).toHaveLength(1);
    // The first target is still the same row when asked again.
    expect(await ask(s)).toMatchObject({ outcome: "existing" });
  });

  test("two targets that each name their source are two intents; the first one is given its source by asking again", async () => {
    const s = await runningTurn();
    const first = await ask(s);
    if (first.outcome !== "created") throw new Error("expected created");
    expect(first.intent.source_ref).toBeNull();
    const docs = `agent/${s.sessionId}-docs`;
    expect(await ask(s, docs, { sourceRef: "docs-work" })).toEqual({
      outcome: "source_ref_required",
      targetBranch: `agent/${s.sessionId}`,
    });
    const named = await ask(s, undefined, { sourceRef: "main-work" });
    expect(named).toMatchObject({
      outcome: "existing",
      intent: { id: first.intent.id, source_ref: "main-work" },
    });
    const second = await ask(s, docs, { sourceRef: "docs-work" });
    expect(second).toMatchObject({
      outcome: "created",
      intent: { source_ref: "docs-work" },
    });
    const listed = await intents.list(OWNER, s.sessionId);
    expect(listed.map((row) => row.source_ref).sort()).toEqual([
      "docs-work",
      "main-work",
    ]);
    expect(await ask(s, docs)).toMatchObject({
      outcome: "existing",
      intent: { source_ref: "docs-work" },
    });
  });

  test("a settled intent keeps the source it was pinned with", async () => {
    const s = await runningTurn();
    const first = await ask(s, undefined, { sourceRef: "one" });
    if (first.outcome !== "created") throw new Error("expected created");
    await db
      .update(pushIntents)
      .set({ status: "pinned", pinnedRevision: 2 })
      .where(eq(pushIntents.id, first.intent.id));
    expect(await ask(s, undefined, { sourceRef: "other" })).toMatchObject({
      outcome: "existing",
      intent: { source_ref: "one" },
    });
  });

  test("rows stored before the rule: asking for the second stored target is still that row", async () => {
    const s = await runningTurn();
    const first = await ask(s);
    if (first.outcome !== "created") throw new Error("expected created");
    const secondTarget = `agent/${s.sessionId}-docs`;
    // Written the way the code before the rule did: a second target row.
    const [seeded] = await db
      .insert(pushIntents)
      .values({
        id: crypto.randomUUID(),
        ownerId: OWNER,
        sessionId: s.sessionId,
        turnId: s.turnId,
        attemptId: "attempt-1",
        repositoryId: "sample-app",
        targetBranch: secondTarget,
        actor: ACTOR,
        approvalBasis: "push.primary",
        policySource: "agent",
      })
      .returning({ id: pushIntents.id });
    if (!seeded) throw new Error("no seeded row");
    const again = await ask(s, secondTarget);
    expect(again).toMatchObject({ outcome: "existing" });
    if (again.outcome !== "existing") throw new Error("unreachable");
    expect(again.intent.id).toBe(seeded.id);
    // A third target is still refused, naming the oldest row.
    expect(await ask(s, `agent/${s.sessionId}-extra`)).toEqual({
      outcome: "source_ref_required",
      targetBranch: `agent/${s.sessionId}`,
    });
  });

  test("another repository of the same turn is its own intent once each names its source; without one it would push the wrong commit", async () => {
    const s = await runningTurn();
    await ask(s);
    expect(await ask(s, undefined, { repositoryId: "docs" })).toEqual({
      outcome: "source_ref_required",
      targetBranch: `agent/${s.sessionId}`,
    });
    await ask(s, undefined, { sourceRef: "app-work" });
    const other = await ask(s, undefined, {
      repositoryId: "docs",
      sourceRef: "docs-work",
    });
    expect(other.outcome).toBe("created");
    expect(await intents.list(OWNER, s.sessionId)).toHaveLength(2);
  });

  test("a request made without origin is direct and legacy", async () => {
    const s = await runningTurn();
    const request = written(await createRequest(s.sessionId));
    const [row] = await db
      .select()
      .from(pushRequests)
      .where(eq(pushRequests.id, request.id));
    expect(row).toMatchObject({
      origin: "direct",
      flow: "legacy",
      prState: null,
      pullRequestIntent: null,
    });
  });

  test("a direct request still needs the pointer on its revision; an intent request does not", async () => {
    const s = await runningTurn(5);
    expect(await createRequest(s.sessionId)).toMatchObject({
      outcome: "refused",
      refusal: "checkpoint_moved",
    });
    const request = written(
      await createRequest(s.sessionId, { origin: "intent" }),
    );
    const [row] = await db
      .select()
      .from(pushRequests)
      .where(eq(pushRequests.id, request.id));
    // Always `actions`, even when the caller said nothing.
    expect(row).toMatchObject({ origin: "intent", flow: "actions" });
  });

  test("an intent request is approved after the pointer moved on; a direct one is not", async () => {
    const decide = (sessionId: string, id: string) =>
      requests.decide({
        ownerId: OWNER,
        sessionId,
        pushRequestId: id,
        actor: ACTOR,
        decision: "approve",
        gitCommit: COMMIT,
        reason: null,
        idempotencyKey: crypto.randomUUID(),
        payloadHash: "h-decide",
      });
    const a = await runningTurn(2);
    const intentRequest = written(
      await createRequest(a.sessionId, { origin: "intent" }),
    );
    const b = await runningTurn(2);
    const directRequest = written(await createRequest(b.sessionId));
    for (const id of [a.sessionId, b.sessionId]) {
      await db
        .update(sessions)
        .set({ checkpointRevision: 9 })
        .where(eq(sessions.id, id));
    }
    expect(await decide(b.sessionId, directRequest.id)).toMatchObject({
      outcome: "refused",
      refusal: "checkpoint_moved",
    });
    expect(await decide(a.sessionId, intentRequest.id)).toMatchObject({
      outcome: "written",
      request: { state: "approved" },
    });
  });

  test("a later push to the same target waits while an earlier pull request is due or opening", async () => {
    for (const prState of ["due", "opening"]) {
      const s = await runningTurn();
      const first = written(await createRequest(s.sessionId));
      // The earlier push is finished; only its PR stage is open.
      await db
        .update(pushRequests)
        .set({
          state: "pushed",
          decidedAt: new Date(),
          decidedBy: ACTOR,
          decisionReceiptId: first.request_receipt_id,
          prState,
        })
        .where(eq(pushRequests.id, first.id));
      const second = await createRequest(s.sessionId);
      expect(second).toMatchObject({
        outcome: "refused",
        refusal: "request_open",
        reason: "pull_request_pending",
      });
    }
  });

  test("a finished pull request stage does not hold the target", async () => {
    const s = await runningTurn();
    const first = written(await createRequest(s.sessionId));
    await db
      .update(pushRequests)
      .set({
        state: "pushed",
        decidedAt: new Date(),
        decidedBy: ACTOR,
        decisionReceiptId: first.request_receipt_id,
        prState: "opened",
      })
      .where(eq(pushRequests.id, first.id));
    expect((await createRequest(s.sessionId)).outcome === "written").toBe(true);
  });
});
