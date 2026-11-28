import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { AuthAttemptKey } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../schema.ts";
import { createPostgresAuthAttemptStore } from "./auth-attempts.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

integration("sign-in attempt windows under concurrency", () => {
  let database: TempDatabase;
  const pools: Pool[] = [];

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "auth_attempts" });
    for (let i = 0; i < 2; i += 1) {
      pools.push(new Pool({ connectionString: database.url, max: 8 }));
    }
  }, 60_000);

  afterAll(async () => {
    await Promise.all(pools.map((pool) => pool.end()));
    await database?.drop();
  });

  test("two replicas racing on one key admit the limit and close it once", async () => {
    const replicas = pools.map((pool) =>
      createPostgresAuthAttemptStore(drizzle(pool, { schema })),
    );
    const rule = { limit: 5, windowMs: 15 * 60 * 1000 };
    const key = "raced" as AuthAttemptKey;
    const taken = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        (replicas[i % 2] ?? replicas[0])?.take("ip_failure", key, rule),
      ),
    );
    expect(taken.filter((one) => one?.admitted)).toHaveLength(rule.limit);
    expect(
      taken.filter((one) => one && !one.admitted && one.closedNow),
    ).toHaveLength(1);
  });
});
