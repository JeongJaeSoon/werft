import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { type ClaimCatalog, HEARTBEAT_STATES } from "@werft-ai/platform";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import * as schema from "./schema.ts";
import { sessions } from "./schema.ts";
import { sessionPinColumns } from "./testing/spec-pins.ts";
import {
  ATTEMPT_PHASE_ORDER,
  runnableCondition,
  runsHere,
} from "./worker-unit-of-work.ts";

// The claim picks candidates with runnableCondition in SQL and re-checks the
// locked row with runsHere in JS; a row one accepts and the other refuses is
// either never claimed or claimed against the catalog.

const REPO_A = {
  repositoryId: "repo-a",
  url: "https://example.invalid/a.git",
  branch: "main",
};
const RUNNABLE: ClaimCatalog = {
  connections: [
    { id: "conn-a", models: ["model-a", "model-b"] },
    { id: "conn-b", models: ["model-b"] },
  ],
  repositories: [REPO_A],
  runtimeVersions: ["1.0.0"],
};

const connection = (id: string) => ({
  id,
  kind: "anthropic" as const,
  endpoint: "https://api.anthropic.invalid",
  billing: "per_token" as const,
});

type Row = Omit<typeof sessions.$inferInsert, "id" | "ownerId">;

// Every pin a row can hold (none; each connection, model and runtime
// version, offered or not), crossed with every repository a row can name.
function rows(): Row[] {
  const pins: Row[] = [{ model: null }, { model: "model-a" }];
  for (const conn of ["conn-a", "conn-b", "conn-z"]) {
    for (const model of ["model-a", "model-b", "model-z"]) {
      for (const version of ["1.0.0", "9.9.9"]) {
        pins.push(
          sessionPinColumns(model, {
            connection: connection(conn),
            runtime: { kind: "claude_agent_sdk", version },
          }),
        );
      }
    }
  }
  const repositories: Row[] = [
    { repositoryMode: "none", repositoryId: null, repoUrl: null, branch: null },
    {
      repositoryMode: "repository",
      repositoryId: REPO_A.repositoryId,
      repoUrl: REPO_A.url,
      branch: REPO_A.branch,
    },
    {
      repositoryMode: "repository",
      repositoryId: "repo-z",
      repoUrl: REPO_A.url,
      branch: REPO_A.branch,
    },
    {
      repositoryMode: "repository",
      repositoryId: REPO_A.repositoryId,
      repoUrl: REPO_A.url,
      branch: "other",
    },
    // Before the catalog: a URL and no key.
    {
      repositoryMode: "repository",
      repositoryId: null,
      repoUrl: REPO_A.url,
      branch: REPO_A.branch,
    },
  ];
  return pins.flatMap((pin) =>
    repositories.map((repository) => ({ ...pin, ...repository })),
  );
}

let client: PGlite;
let db: PgliteDatabase<typeof schema>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: `${import.meta.dir}/../migrations` });
  await db.insert(sessions).values(
    rows().map((row) => ({
      ...row,
      id: crypto.randomUUID(),
      ownerId: "owner-a",
    })),
  );
});

afterAll(async () => {
  await client.close();
});

describe("runnable judgement", () => {
  // conn-a offers model-a and model-b, conn-b model-b: three pairs, on the
  // offered runtime only, each with a row of mode none and one on repo-a.
  for (const [name, runnable, matched] of [
    ["both connections", RUNNABLE, 6],
    [
      "one connection",
      { ...RUNNABLE, connections: RUNNABLE.connections.slice(1) },
      2,
    ],
    ["every runtime", { ...RUNNABLE, runtimeVersions: null }, 12],
    ["no runtime", { ...RUNNABLE, runtimeVersions: [] }, 0],
    ["no repository", { ...RUNNABLE, repositories: [] }, 3],
    ["no connection", { ...RUNNABLE, connections: [] }, 0],
  ] as const) {
    test(`SQL and JS pick the same sessions with ${name}`, async () => {
      const all = await db.select().from(sessions);
      const inJs = all
        .filter((row) => runsHere(row, runnable))
        .map((row) => row.id)
        .sort();
      const inSql = (
        await db
          .select({ id: sessions.id })
          .from(sessions)
          .where(runnableCondition(runnable))
      )
        .map((row) => row.id)
        .sort();
      expect(inSql).toEqual(inJs);
      expect(inJs).toHaveLength(matched);
    });
  }

  test("a row without a pin, or from before the catalog, is never runnable", async () => {
    const all = await db.select().from(sessions);
    const picked = all.filter((row) =>
      runsHere(row, { ...RUNNABLE, runtimeVersions: null }),
    );
    expect(picked.every((row) => row.runtimeSpec !== null)).toBe(true);
    expect(
      picked.every(
        (row) => row.repositoryMode === "none" || row.repositoryId !== null,
      ),
    ).toBe(true);
  });
});

test("a heartbeat can report exactly the phases the attempt state advances through, in that order", () => {
  const phases = Object.entries(ATTEMPT_PHASE_ORDER)
    .sort(([, left], [, right]) => left - right)
    .map(([state]) => state);
  expect(phases).toEqual([...HEARTBEAT_STATES]);
});
