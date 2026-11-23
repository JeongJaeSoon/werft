import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  createAuthorizationPolicy,
  createPendingRequestService,
  type SessionCatalog,
  SessionServiceError,
  type WorkerGateway,
} from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "./schema.ts";
import { pendingRequests } from "./schema.ts";
import { createPostgresWorkerPendingStore } from "./sessions/pending-control.ts";
import { createPostgresPendingRequests } from "./sessions/pending-requests.ts";
import { testWorkerGateway } from "./testing/gateway.ts";
import { claimedSession } from "./testing/sessions.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";

/**
 * an answer that comes after the request expired is late, whatever
 * became of the attempt that asked since. Only an asker gone before the
 * expiry makes it stale.
 */

const OWNER = testCaller("00000000-0000-4000-8000-00000000000a");
const CATALOG: SessionCatalog = testSessionCatalog({
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "provider-key",
      ref: { stored: "connection:test-connection" },
    },
  },
  models: ["claude-sonnet-5"],
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      auth: { kind: "github_app", registered: true },
    },
  },
});

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let gateway: WorkerGateway;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  gateway = testWorkerGateway(db, CATALOG, {
    pending: createPostgresWorkerPendingStore(db),
  });
});

afterEach(async () => {
  await client.close();
});

/** A session whose first turn has a permission request open on its worker. */
async function askingSession() {
  const { sessionId, principal, scope } = await claimedSession(
    db,
    gateway,
    OWNER,
  );
  const next = await gateway.nextInput(principal, scope);
  if (!next.input) throw new Error("no input delivered");
  const requestId = `req_${crypto.randomUUID()}`;
  await gateway.registerPending(principal, {
    ...scope,
    turn_id: next.input.turn_id,
    request_id: requestId,
    input_hash: "a".repeat(64),
    request: { kind: "permission", tool: "Bash", input: { command: "ls" } },
  });
  // The worker goes away: nobody is left to hand an answer to.
  const askerLeaves = () =>
    gateway.release(principal, { ...scope, turn_id: null, reason: "replaced" });
  return { sessionId, requestId, askerLeaves };
}

async function answerCode(sessionId: string, requestId: string) {
  const service = createPendingRequestService({
    authorization: createAuthorizationPolicy(),
    store: createPostgresPendingRequests(db),
  });
  try {
    await service.answer(OWNER, sessionId, {
      idempotencyKey: crypto.randomUUID(),
      body: { request_id: requestId, kind: "permission", decision: "allow" },
    });
  } catch (error) {
    if (error instanceof SessionServiceError) return error.code;
    throw error;
  }
  throw new Error("expected the answer to be refused");
}

describe("answering a request whose asker is gone", () => {
  test("past its expiry it is REQUEST_EXPIRED, though the asker left too", async () => {
    const { sessionId, requestId, askerLeaves } = await askingSession();
    await db
      .update(pendingRequests)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(pendingRequests.requestId, requestId));
    await askerLeaves();
    expect(await answerCode(sessionId, requestId)).toBe("REQUEST_EXPIRED");
  });

  test("before its expiry it is REQUEST_STALE", async () => {
    const { sessionId, requestId, askerLeaves } = await askingSession();
    await askerLeaves();
    expect(await answerCode(sessionId, requestId)).toBe("REQUEST_STALE");
  });
});
