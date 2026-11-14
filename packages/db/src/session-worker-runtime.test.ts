import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { testCaller } from "@werft-ai/testkit/callers";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import {
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
} from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { sessions } from "./schema.ts";
import { fixtureRelease, TEST_MODEL } from "./testing/spec-pins.ts";

const OWNER = testCaller("00000000-0000-4000-8000-00000000000a");
const FIRST = {
  engine: "claude",
  sdk_version: "0.3.270",
  cli_version: "2.1.270",
  profile_sha256: "a".repeat(64),
};
const LATER = {
  ...FIRST,
  cli_version: "2.1.280",
  profile_sha256: "b".repeat(64),
};

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

async function create(): Promise<string> {
  const created = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    principal: OWNER,
    idempotencyKey: crypto.randomUUID(),
    payloadHash: crypto.randomUUID(),
    title: null,
    titleSource: "derived",
    repository: {
      id: "app",
      url: "https://example.invalid/app.git",
      branch: "main",
    },
    agentReleaseId: await fixtureRelease(db),
    model: TEST_MODEL,
    message: "hello",
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
  });
  if (created.outcome !== "accepted") throw new Error(created.outcome);
  return created.response.session_id;
}

async function launched(sessionId: string) {
  await db
    .update(sessions)
    .set({
      firstWorkerImage: "ghcr.io/x/worker@sha256:aa",
      runtimeEngine: FIRST.engine,
      runtimeSdkVersion: FIRST.sdk_version,
      runtimeCliVersion: FIRST.cli_version,
      runtimeProfileSha256: FIRST.profile_sha256,
    })
    .where(eq(sessions.id, sessionId));
}

async function checkpoint(
  sessionId: string,
  revision: number,
  runtime: typeof FIRST | null,
  scheme: number | null = null,
) {
  await client.query(
    `INSERT INTO checkpoints (session_id, revision, manifest_ref, manifest_sha256,
       runtime_engine, runtime_sdk_version, runtime_cli_version, runtime_profile_sha256,
       runtime_profile_scheme)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      sessionId,
      revision,
      `sessions/${sessionId}/checkpoints/${revision}/manifest.json`,
      "c".repeat(64),
      runtime?.engine ?? null,
      runtime?.sdk_version ?? null,
      runtime?.cli_version ?? null,
      runtime?.profile_sha256 ?? null,
      scheme,
    ],
  );
  await client.query(
    "UPDATE sessions SET checkpoint_revision = $2 WHERE id = $1",
    [sessionId, revision],
  );
}

const runtimeOf = async (sessionId: string) =>
  (await createPostgresSessionReader(db).getSession(OWNER.ownerId, sessionId))
    ?.worker_runtime;

describe("session worker runtime (94S-1092)", () => {
  test("a session never launched has nothing recorded", async () => {
    expect(await runtimeOf(await create())).toEqual({
      first_image: null,
      first: null,
      checkpoint: null,
    });
  });

  test("the first launch's record and the pointer's combination are shown apart", async () => {
    const id = await create();
    await launched(id);
    await checkpoint(id, 1, FIRST);
    await checkpoint(id, 2, LATER, 2);
    expect(await runtimeOf(id)).toEqual({
      first_image: "ghcr.io/x/worker@sha256:aa",
      first: FIRST,
      checkpoint: { ...LATER, profile_digest_scheme: 2 },
    });
  });

  test("a pointer from before the digest scheme was recorded reads as scheme 1, as a launch does", async () => {
    const id = await create();
    await launched(id);
    await checkpoint(id, 1, FIRST);
    expect((await runtimeOf(id))?.checkpoint).toEqual({
      ...FIRST,
      profile_digest_scheme: 1,
    });
  });

  test("a pointer no launch restores, or one sealed without a fingerprint, shows none", async () => {
    const unrecorded = await create();
    await launched(unrecorded);
    await checkpoint(unrecorded, 1, null);
    expect((await runtimeOf(unrecorded))?.checkpoint).toBeNull();

    const reset = await create();
    await launched(reset);
    await checkpoint(reset, 1, FIRST);
    await db
      .update(sessions)
      .set({ contextResetCheckpointRevision: 1 })
      .where(eq(sessions.id, reset));
    expect(await runtimeOf(reset)).toEqual({
      first_image: "ghcr.io/x/worker@sha256:aa",
      first: FIRST,
      checkpoint: null,
    });
  });
});
