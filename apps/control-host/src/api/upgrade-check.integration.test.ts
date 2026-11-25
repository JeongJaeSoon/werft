import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createLogger } from "@werft-ai/observability";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { Pool } from "pg";
import { databaseUnused, runUpgradeCheck } from "./upgrade-check.ts";

const integration = process.env.QUEUE_DATABASE_URL ? describe : describe.skip;
const unused = databaseUnused(createLogger({ sinks: [{ write() {} }] }));

integration("databaseUnused on PostgreSQL", () => {
  let database: TempDatabase;

  afterEach(() => database.drop());

  async function given(options: { migrate: boolean }, ...sql: string[]) {
    database = await createTempDatabase({
      ...options,
      prefix: "upgrade_check",
    });
    const pool = new Pool({ connectionString: database.url });
    try {
      for (const statement of sql) await pool.query(statement);
    } finally {
      await pool.end();
    }
    return unused(database.url);
  }

  const journal = [
    'CREATE SCHEMA "drizzle"',
    'CREATE TABLE "drizzle"."__drizzle_migrations" (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)',
  ];

  test("a database never migrated is unused", async () => {
    expect(await given({ migrate: false })).toBe(true);
  });

  test("a journal with no row, which a failed migrate leaves, is unused", async () => {
    expect(await given({ migrate: false }, ...journal)).toBe(true);
  });

  test("a migrated database with no session is unused", async () => {
    expect(await given({ migrate: true })).toBe(true);
  });

  test("a session of any kind, with no checkpoint, is use", async () => {
    expect(
      await given(
        { migrate: false },
        "CREATE TABLE sessions (id text)",
        "INSERT INTO sessions VALUES ('s-1')",
      ),
    ).toBe(false);
  });

  test("a schema without sessions is use, not a first install", async () => {
    expect(
      await given({ migrate: false }, "CREATE TABLE checkpoints (id text)"),
    ).toBe(false);
  });

  test("journal rows without a schema are use", async () => {
    expect(
      await given(
        { migrate: false },
        ...journal,
        `INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ('h', 1)`,
      ),
    ).toBe(false);
  });
});

integration("runUpgradeCheck on PostgreSQL", () => {
  let database: TempDatabase;

  afterEach(() => database.drop());

  const claude = {
    cliVersion: "2.1.280",
    engine: "claude",
    profileDigestScheme: 1,
    sdkVersion: "0.3.280",
  };
  const codex = {
    ...claude,
    cliVersion: "0.9.0",
    engine: "codex",
    sdkVersion: "0.9.0",
  };
  const claudeImage = `worker@sha256:${"a".repeat(64)}`;
  const codexImage = `worker@sha256:${"b".repeat(64)}`;
  const entry = (image: string, runtime: typeof claude) => ({
    image,
    runtime,
    released_at: "2026-11-01T00:00:00Z",
  });

  function insertSession(pool: Pool, id: string, state: string, kind: string) {
    const spec = { runtime: { kind } };
    return pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id, admission_state,
         runtime_spec, spec_source, spec_source_digest, spec_digest)
       VALUES ($1, 'owner', 'https://example.invalid/a.git', 'main', 'repo-a', $2, $3, $3, $4, $4)`,
      [id, state, spec, "d".repeat(64)],
    );
  }

  test("a worker holding a slot is listed when the target gives workers another gateway address, and not when it stays", async () => {
    database = await createTempDatabase({ prefix: "upgrade_check_workers" });
    const pool = new Pool({ connectionString: database.url });
    const [holding, released, unclaimed] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    try {
      for (const [id, claimed, slotReleased] of [
        [holding, true, false],
        [released, true, true],
        [unclaimed, false, false],
      ] as const) {
        await insertSession(pool, id, "active", "claude_agent_sdk");
        if (claimed) {
          await pool.query(
            `INSERT INTO attempts (id, session_id, execution_id, lease_epoch, execution_generation,
               auth_revision, state, lease_expires_at)
             VALUES ($1, $2, $3, 1, 1, 1, 'active', now() + interval '30 seconds')`,
            [`attempt-${id}`, id, `exec-${id}`],
          );
        }
        await pool.query(
          `INSERT INTO worker_launches (execution_id, generation, backend, session_id,
             claimed_attempt_id, slot_released_at)
           VALUES ($1, 1, 'kubernetes', $2, $3, $4)`,
          [
            `exec-${id}`,
            id,
            claimed ? `attempt-${id}` : null,
            slotReleased ? new Date() : null,
          ],
        );
      }
    } finally {
      await pool.end();
    }
    // A control-host-only upgrade: the worker images stay as they are.
    const images = JSON.stringify([entry(claudeImage, claude)]);
    const check = async (deployedGateway: string) => {
      const lines: string[] = [];
      const code = await runUpgradeCheck({
        environment: {
          DATABASE_URL: database.url,
          UPGRADE_DEPLOYED_WORKER_IMAGE: "",
          UPGRADE_DEPLOYED_WORKER_IMAGES: images,
          UPGRADE_DEPLOYED_WORKER_GATEWAY_URL: deployedGateway,
          WORKER_IMAGES: images,
          WORKER_GATEWAY_URL: "http://werft-api-internal:3200",
        },
        logger: createLogger({ sinks: [{ write() {} }] }),
        write: (line) => lines.push(line),
      });
      return { code, output: JSON.parse(lines[0] as string) };
    };

    const moved = await check("http://werft-api:3000");
    expect(moved.code).toBe(2);
    expect(moved.output.affected).toEqual([
      { sessionId: holding, reason: "worker_ends" },
    ]);

    const stays = await check("http://werft-api-internal:3200");
    expect(stays.code).toBe(0);
    expect(stays.output.affected).toEqual([]);
  }, 60_000);

  test("dropping an engine lists its open sessions by the engine their runtime kind runs on", async () => {
    database = await createTempDatabase({ prefix: "upgrade_check_engine" });
    const pool = new Pool({ connectionString: database.url });
    const [openCodex, openClaude, closedCodex] = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];
    try {
      for (const [id, state, kind] of [
        [openCodex, "active", "codex_app_server"],
        [openClaude, "active", "claude_agent_sdk"],
        [closedCodex, "closed", "codex_app_server"],
      ] as const) {
        await insertSession(pool, id, state, kind);
      }
    } finally {
      await pool.end();
    }
    const lines: string[] = [];
    const code = await runUpgradeCheck({
      environment: {
        DATABASE_URL: database.url,
        UPGRADE_DEPLOYED_WORKER_IMAGE: "",
        UPGRADE_DEPLOYED_WORKER_IMAGES: JSON.stringify([
          entry(claudeImage, claude),
          entry(codexImage, codex),
        ]),
        UPGRADE_DEPLOYED_WORKER_GATEWAY_URL: "http://werft-api-internal:3200",
        WORKER_IMAGES: JSON.stringify([entry(claudeImage, claude)]),
        WORKER_GATEWAY_URL: "http://werft-api-internal:3200",
      },
      logger: createLogger({ sinks: [{ write() {} }] }),
      listWriters: async () => [],
      write: (line) => lines.push(line),
    });
    expect(code).toBe(2);
    expect(JSON.parse(lines[0] as string).affected).toEqual([
      { sessionId: openCodex, reason: "no_engine_image" },
    ]);
  }, 60_000);
});
