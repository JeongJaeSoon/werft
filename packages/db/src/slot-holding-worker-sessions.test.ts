import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { SessionCatalog, WorkerGateway } from "@werft-ai/platform";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { listSlotHoldingWorkerSessions } from "./checkpoints/checkpoint-runtime.ts";
import * as schema from "./schema.ts";
import { testWorkerGateway } from "./testing/gateway.ts";
import { confirmExecutionGone, launchSession } from "./testing/launches.ts";
import { claimedSession, newPartitionedSession } from "./testing/sessions.ts";
import { testSessionCatalog } from "./testing/spec-pins.ts";

const OWNER = testCaller("00000000-0000-4000-8000-00000000000b");
const CATALOG: SessionCatalog = testSessionCatalog({
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
  gateway = testWorkerGateway(db, CATALOG);
});

afterEach(async () => {
  await client.close();
});

test("lists the session of each launch a worker claimed that still holds its slot", async () => {
  const first = await claimedSession(db, gateway, OWNER);
  const second = await claimedSession(db, gateway, OWNER);

  expect(await listSlotHoldingWorkerSessions(db)).toEqual(
    [first.sessionId, second.sessionId].sort(),
  );
});

test("leaves out a launch no worker claimed, and a worker whose slot was released", async () => {
  const unclaimed = await newPartitionedSession(db, "unclaimed");
  await launchSession(db, { sessionId: unclaimed.sessionId });
  const gone = await claimedSession(db, gateway, OWNER);
  const running = await claimedSession(db, gateway, OWNER);
  await confirmExecutionGone(db, gone.executionId);

  expect(await listSlotHoldingWorkerSessions(db)).toEqual([running.sessionId]);
});
