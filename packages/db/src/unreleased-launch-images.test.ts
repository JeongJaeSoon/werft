import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { listUnreleasedLaunchImages } from "./checkpoints/checkpoint-runtime.ts";
import * as schema from "./schema.ts";
import { workerLaunches } from "./schema.ts";

const RUNTIME = {
  engine: "claude",
  sdkVersion: "0.3.280",
  cliVersion: "2.1.280",
  profileDigestScheme: 2,
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

async function launch(
  image: string | null,
  options: { runtime?: boolean; released?: boolean } = {},
) {
  await db.insert(workerLaunches).values({
    backend: "kubernetes",
    executionId: crypto.randomUUID(),
    generation: 1,
    image,
    resources: image === null ? null : {},
    ...(options.runtime
      ? {
          runtimeEngine: RUNTIME.engine,
          runtimeSdkVersion: RUNTIME.sdkVersion,
          runtimeCliVersion: RUNTIME.cliVersion,
          runtimeProfileScheme: RUNTIME.profileDigestScheme,
        }
      : {}),
    ...(options.released ? { slotReleasedAt: new Date() } : {}),
  });
}

test("lists each image a launch still holding a slot runs, once, with the runtime it was reserved under", async () => {
  await launch("worker@sha256:a", { runtime: true });
  await launch("worker@sha256:a", { runtime: true });
  await launch("worker@sha256:b");
  await launch("worker@sha256:released", { runtime: true, released: true });
  await launch(null);

  const listed = await listUnreleasedLaunchImages(db);
  expect(listed.sort((x, y) => x.image.localeCompare(y.image))).toEqual([
    { image: "worker@sha256:a", runtime: RUNTIME },
    { image: "worker@sha256:b", runtime: null },
  ]);
});

test("is empty when every slot was released", async () => {
  await launch("worker@sha256:a", { runtime: true, released: true });
  expect(await listUnreleasedLaunchImages(db)).toEqual([]);
});
