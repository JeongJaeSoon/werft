import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { PlatformPrompt } from "@werft-ai/contracts";
import type { AcceptSessionInput } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createPostgresSessionUnitOfWork } from "./postgres-unit-of-work.ts";
import * as schema from "./schema.ts";
import { sessions } from "./schema.ts";
import { fixtureRelease, TEST_MODEL } from "./testing/spec-pins.ts";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
});

afterEach(async () => {
  await client.close();
});

const prompt: PlatformPrompt = {
  prompt_revision: 1,
  agent_identity: { name: "code-review", description: "Reviews" },
  origin_surface: "slack_channel",
  language: "ko",
  repository: "acme/app",
};

async function accept(
  extra: Partial<AcceptSessionInput>,
  idempotencyKey = randomUUID(),
) {
  return createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: { ownerId: "00000000-0000-4000-8000-00000000000a" },
    idempotencyKey,
    payloadHash: "hash",
    agentReleaseId: await fixtureRelease(db),
    model: TEST_MODEL,
    repository: {
      id: "app",
      url: "https://github.com/acme/app.git",
      branch: "main",
    },
    message: "hello",
    ...extra,
  });
}

async function storedPrompt(sessionId: string) {
  const [row] = await db
    .select({ platformPrompt: sessions.platformPrompt })
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row?.platformPrompt;
}

describe("a session's platform prompt", () => {
  test("is stored as given with the row, and a session without one is revision 0", async () => {
    const prompted = await accept({ platformPrompt: prompt });
    if (prompted.outcome !== "accepted") throw new Error(prompted.outcome);
    expect(await storedPrompt(prompted.response.session_id)).toEqual(prompt);

    const plain = await accept({});
    if (plain.outcome !== "accepted") throw new Error(plain.outcome);
    expect(await storedPrompt(plain.response.session_id)).toBeNull();
  });

  test("a replay keeps the row the first acceptance wrote", async () => {
    const key = randomUUID();
    const first = await accept({ platformPrompt: prompt }, key);
    if (first.outcome !== "accepted") throw new Error(first.outcome);
    const again = await accept(
      {
        platformPrompt: {
          ...prompt,
          agent_identity: { name: "renamed", description: null },
        },
      },
      key,
    );
    expect(again.outcome).toBe("replayed");
    expect(await storedPrompt(first.response.session_id)).toEqual(prompt);
  });
});
