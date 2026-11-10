import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import {
  listUncollectedSessionPointers,
  readPointerRuntime,
} from "./checkpoint-runtime.ts";
import { migrate } from "./migrate.ts";
import * as schema from "./schema.ts";
import {
  BEFORE_PROFILE_REMOVAL,
  migrationsThrough as migrationsUpTo,
} from "./testing/migrations-through.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

// Up to the profile removal: 0267 empties the session tables these rows sit in.
async function migrateBeforeRemoval(db: Parameters<typeof migrate>[0]) {
  const folder = migrationsUpTo(BEFORE_PROFILE_REMOVAL);
  try {
    await migrate(db, { migrationsFolder: folder });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

const MIGRATIONS = join(import.meta.dir, "../migrations");

type Journal = { entries: Array<{ tag: string }> };

async function migrationsThrough(lastTag: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "checkpoint-runtime-"));
  await mkdir(join(folder, "meta"));
  const journal: Journal = JSON.parse(
    await readFile(join(MIGRATIONS, "meta/_journal.json"), "utf8"),
  );
  const last = journal.entries.findIndex((entry) => entry.tag === lastTag);
  if (last === -1) throw new Error(`no migration ${lastTag}`);
  const entries = journal.entries.slice(0, last + 1);
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const { tag } of entries) {
    await copyFile(join(MIGRATIONS, `${tag}.sql`), join(folder, `${tag}.sql`));
  }
  return folder;
}

integration("checkpoint runtime columns, expand", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let before: string;

  beforeEach(async () => {
    database = await createTempDatabase({
      migrate: false,
      prefix: "checkpoint_runtime_it",
    });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
    before = await migrationsThrough("0195_github_workflow_dispatches");
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
    await rm(before, { recursive: true, force: true });
  }, 60_000);

  test("a pointer committed before the columns reads as no recorded runtime", async () => {
    await migrate(db, { migrationsFolder: before });
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id)
       VALUES ($1, 'owner', 'https://example.invalid/a.git', 'main', 'repo-a')`,
      [sessionId],
    );
    await pool.query(
      `INSERT INTO checkpoints (session_id, revision, manifest_ref, manifest_sha256)
       VALUES ($1, 0, 'sessions/s/checkpoints/0/manifest.json', $2)`,
      [sessionId, "a".repeat(64)],
    );
    await pool.query(
      "UPDATE sessions SET checkpoint_revision = 0 WHERE id = $1",
      [sessionId],
    );

    await migrateBeforeRemoval(db);

    expect(
      (
        await pool.query(
          `SELECT runtime_engine, runtime_sdk_version, runtime_cli_version, runtime_profile_sha256
           FROM checkpoints WHERE session_id = $1`,
          [sessionId],
        )
      ).rows,
    ).toEqual([
      {
        runtime_engine: null,
        runtime_sdk_version: null,
        runtime_cli_version: null,
        runtime_profile_sha256: null,
      },
    ]);
    expect(await readPointerRuntime(db, sessionId)).toBeNull();
  }, 60_000);

  test("a session from before its pin columns keeps them null", async () => {
    const through = await migrationsThrough("0197_github_app_client_id");
    try {
      await migrate(db, { migrationsFolder: through });
    } finally {
      await rm(through, { recursive: true, force: true });
    }
    const sessionId = randomUUID();
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id)
       VALUES ($1, 'owner', 'https://example.invalid/a.git', 'main', 'repo-a')`,
      [sessionId],
    );

    await migrateBeforeRemoval(db);

    expect(
      (
        await pool.query(
          `SELECT first_worker_image, runtime_engine, runtime_sdk_version,
                  runtime_cli_version, runtime_profile_sha256
           FROM sessions WHERE id = $1`,
          [sessionId],
        )
      ).rows,
    ).toEqual([
      {
        first_worker_image: null,
        runtime_engine: null,
        runtime_sdk_version: null,
        runtime_cli_version: null,
        runtime_profile_sha256: null,
      },
    ]);
  }, 60_000);
});

integration("listUncollectedSessionPointers", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeEach(async () => {
    database = await createTempDatabase({ prefix: "uncollected_pointers_it" });
    pool = new Pool({ connectionString: database.url, max: 2 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterEach(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  async function session(id: string) {
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id)
       VALUES ($1, 'owner', 'https://example.invalid/a.git', 'main', 'repo-a')`,
      [id],
    );
  }

  async function checkpoint(
    sessionId: string,
    revision: number,
    options: { runtime?: boolean; collected?: boolean; pointer?: boolean },
  ) {
    await pool.query(
      `INSERT INTO checkpoints (session_id, revision, manifest_ref, manifest_sha256,
         runtime_engine, runtime_sdk_version, runtime_cli_version, runtime_profile_sha256,
         runtime_profile_scheme, collected_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        sessionId,
        revision,
        `sessions/${sessionId}/checkpoints/${revision}/manifest.json`,
        "a".repeat(64),
        options.runtime ? "claude" : null,
        options.runtime ? "0.3.270" : null,
        options.runtime ? "2.1.270" : null,
        options.runtime ? "b".repeat(64) : null,
        options.runtime ? 2 : null,
        options.collected ? new Date() : null,
      ],
    );
    if (options.pointer) {
      await pool.query(
        "UPDATE sessions SET checkpoint_revision = $2 WHERE id = $1",
        [sessionId, revision],
      );
    }
  }

  test("lists sessions with an uncollected checkpoint and reads each pointer as a launch would", async () => {
    const [recorded, unrecorded, noPointer, retired, collected, empty] = [
      "a",
      "b",
      "c",
      "d",
      "e",
      "f",
    ].map((prefix) => `${prefix}${randomUUID().slice(1)}`) as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    for (const id of [
      recorded,
      unrecorded,
      noPointer,
      retired,
      collected,
      empty,
    ]) {
      await session(id);
    }
    await checkpoint(recorded, 0, { collected: true, runtime: false });
    await checkpoint(recorded, 1, { pointer: true, runtime: true });
    await checkpoint(unrecorded, 0, { pointer: true, runtime: false });
    await checkpoint(noPointer, 0, { runtime: true });
    // A start_fresh decision retires the pointer: nothing is restored.
    await checkpoint(retired, 0, { pointer: true, runtime: false });
    await pool.query(
      "UPDATE sessions SET context_reset_checkpoint_revision = 0 WHERE id = $1",
      [retired],
    );
    await checkpoint(collected, 0, { collected: true, runtime: true });

    expect(await listUncollectedSessionPointers(db)).toEqual([
      {
        sessionId: recorded,
        pointer: {
          kind: "recorded",
          runtime: {
            engine: "claude",
            sdkVersion: "0.3.270",
            cliVersion: "2.1.270",
            profileDigestScheme: 2,
          },
        },
      },
      { sessionId: unrecorded, pointer: { kind: "unrecorded" } },
      { sessionId: noPointer, pointer: { kind: "none" } },
      { sessionId: retired, pointer: { kind: "none" } },
    ]);
  }, 60_000);
});
