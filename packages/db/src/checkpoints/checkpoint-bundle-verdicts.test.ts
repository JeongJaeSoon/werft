import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import * as schema from "../schema.ts";
import { checkpointBundleVerdicts, checkpoints, sessions } from "../schema.ts";
import {
  createPostgresCheckpointStore,
  forgetLostCheckpoints,
} from "./checkpoint-store.ts";

/**
 * Remembered bundle verdicts in the database: what `recordBundleVerdict`
 * keeps, and that a verdict never outlives its checkpoint or one of its
 * prerequisites, whichever write removes them (the trigger
 * checkpoints_forget_bundle_verdicts).
 */

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let store: ReturnType<typeof createPostgresCheckpointStore>;
let sessionId: string;

const digest = (revision: number) => `manifest-${revision}`;

async function sessionWithCheckpoints(revisions: number): Promise<string> {
  const id = crypto.randomUUID();
  await db.insert(sessions).values({
    id,
    ownerId: "owner-verdicts",
    repoUrl: "https://example.invalid/app.git",
    branch: `session/${id}`,
    status: "stopped",
    admissionState: "stopped",
    checkpointRevision: revisions - 1,
  });
  for (let revision = 0; revision < revisions; revision += 1) {
    await db.insert(checkpoints).values({
      sessionId: id,
      revision,
      manifestRef: `${id}/checkpoints/${revision}/manifest.json`,
      manifestSha256: digest(revision),
    });
  }
  return id;
}

/** Revision r's bundles build on those of every revision below it. */
const pass = (revision: number, on = sessionId) => ({
  manifestSha256: digest(revision),
  prerequisiteRevisions: Array.from({ length: revision }, (_, n) => n),
  revision,
  sessionId: on,
});

/** The rows as a verification starting now finds them. */
async function begin(revision: number, on = sessionId): Promise<string> {
  const basis = await store.bundleVerdictBasis?.(pass(revision, on));
  if (basis === undefined) throw new Error("the store keeps no verdicts");
  return basis;
}

/** A verification that began and passed with nothing happening in between. */
async function record(
  revision: number,
  on = sessionId,
  key = `key-${revision}`,
) {
  await store.recordBundleVerdict?.({
    ...pass(revision, on),
    basis: await begin(revision, on),
    key,
  });
}

async function remembered(on = sessionId): Promise<number[]> {
  const rows = await store.listBundleVerdicts?.(on, [0, 1, 2, 3]);
  return (rows ?? []).map((row) => row.revision).sort();
}

const collect = (revision: number, on = sessionId) =>
  store.markCollected(on, {
    keep: [0, 1, 2, 3].filter((kept) => kept !== revision),
    throughRevision: 3,
  });

// The statement scripts/lib/checkpoint-pins-cli.ts re-pins with.
const repin = (revision: number, on = sessionId) =>
  client.query(
    `UPDATE checkpoints
     SET manifest_sha256 = $3, manifest_version = $4, versions_held = true
     WHERE session_id = $1 AND revision = $2 AND manifest_sha256 = $5`,
    [on, revision, "repinned", "v2", digest(revision)],
  );

const remove = (revision: number, on = sessionId) =>
  db
    .delete(checkpoints)
    .where(
      and(eq(checkpoints.sessionId, on), eq(checkpoints.revision, revision)),
    );

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  store = createPostgresCheckpointStore(db as never);
  sessionId = await sessionWithCheckpoints(4);
});

afterEach(async () => {
  await client.close();
});

describe("recordBundleVerdict", () => {
  test("keeps one key per checkpoint, the latest, and lists only the revisions asked for", async () => {
    await record(1);
    await record(2);
    await record(2, sessionId, "key-2-again");
    expect(await store.listBundleVerdicts?.(sessionId, [2, 3])).toEqual([
      { key: "key-2-again", revision: 2 },
    ]);
    expect(await store.listBundleVerdicts?.(sessionId, [])).toEqual([]);
  });

  test("keeps nothing for a checkpoint that is not the one judged", async () => {
    // Another manifest than the row's, a collected row, no row at all.
    await store.recordBundleVerdict?.({
      ...pass(0),
      basis: await begin(0),
      key: "key",
      manifestSha256: "another manifest",
    });
    await collect(1);
    await record(1);
    await store.recordBundleVerdict?.({
      basis: "[]",
      key: "key",
      manifestSha256: digest(9),
      prerequisiteRevisions: [],
      revision: 9,
      sessionId,
    });
    expect(await remembered()).toEqual([]);
  });

  test("a prerequisite collected before the verification began does not stop its pass", async () => {
    await collect(0);
    await record(3);
    expect(await remembered()).toEqual([3]);
  });

  test("keeps nothing when a prerequisite has no checkpoint row: nothing would ever withdraw it", async () => {
    await remove(1);
    await record(3);
    expect(await remembered()).toEqual([]);
  });

  test.each([
    ["collected", collect],
    ["re-pinned", repin],
    ["deleted", remove],
  ] as const)(
    "keeps nothing when a prerequisite was %s between the start of the verification and its record: the trigger ran before the verdict existed",
    async (_how, withdraw) => {
      const basis = await begin(3);
      await withdraw(1);
      await store.recordBundleVerdict?.({ ...pass(3), basis, key: "key-3" });
      expect(await remembered()).toEqual([]);
    },
  );

  test("keeps nothing when the checkpoint itself was collected in between", async () => {
    const basis = await begin(3);
    await collect(3);
    await store.recordBundleVerdict?.({ ...pass(3), basis, key: "key-3" });
    expect(await remembered()).toEqual([]);
  });
});

describe("a verdict goes with its checkpoint and with every checkpoint it builds on", () => {
  let otherSession: string;

  beforeEach(async () => {
    for (const revision of [0, 1, 2, 3]) await record(revision);
    otherSession = await sessionWithCheckpoints(2);
    for (const revision of [0, 1]) await record(revision, otherSession);
  });

  test("garbage collection of revision 1 removes its verdict and those of revisions 2 and 3, which build on it", async () => {
    await collect(1);
    expect(await remembered()).toEqual([0]);
    expect(await remembered(otherSession)).toEqual([0, 1]);
  });

  test("giving lost checkpoints up removes every verdict", async () => {
    await forgetLostCheckpoints(db as never, new Date());
    expect(await remembered()).toEqual([]);
    expect(await remembered(otherSession)).toEqual([]);
  });

  test("re-pinning revision 2 to another manifest removes its verdict and revision 3's", async () => {
    await repin(2);
    expect(await remembered()).toEqual([0, 1]);
  });

  test("deleting a checkpoint row removes its verdict and those built on it; deleting a session's rows removes all of its", async () => {
    await remove(2);
    expect(await remembered()).toEqual([0, 1]);
    await db.delete(checkpoints).where(eq(checkpoints.sessionId, sessionId));
    expect(await remembered()).toEqual([]);
    expect(await remembered(otherSession)).toEqual([0, 1]);
    expect(await db.select().from(checkpointBundleVerdicts)).toHaveLength(2);
  });

  test("a write that changes nothing a verdict depends on keeps it", async () => {
    await collect(0);
    // Revision 0 went, and with it everything that builds on it; recorded
    // again, the purge of revision 0's objects is no reason to forget.
    expect(await remembered()).toEqual([]);
    await record(3);
    await db
      .update(checkpoints)
      .set({ outputsRecorded: true })
      .where(eq(checkpoints.sessionId, sessionId));
    await store.markPurged(sessionId, { keep: [1, 2, 3], throughRevision: 3 });
    expect(await remembered()).toEqual([3]);
  });
});
