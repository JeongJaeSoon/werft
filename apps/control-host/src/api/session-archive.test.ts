import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import { createPostgresInstallationConfigStore } from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { runSessionArchive } from "./session-archive.ts";

function logger() {
  const lines: Array<{ fields?: unknown; message: string }> = [];
  return Object.assign(
    createLogger({
      sinks: [
        {
          write({ fields, message }) {
            lines.push({ fields, message });
          },
        },
      ],
    }),
    { lines },
  );
}

const s3 = {
  AWS_ACCESS_KEY_ID: "id",
  AWS_REGION: "ap-northeast-1",
  AWS_SECRET_ACCESS_KEY: "placeholder-not-a-secret",
  S3_BUCKET: "claude-sessions",
};
const locked = { ...s3, CHECKPOINT_OBJECT_PROTECTION: "locked" };
const running = { ...locked, DATABASE_URL: "postgres://unused" };

let client: PGlite;
beforeAll(async () => {
  client = await migratedPGlite();
});
afterAll(async () => {
  await client.close();
});
beforeEach(async () => {
  await client.exec("DELETE FROM installation_config");
});

const saved = (key: string, value: unknown) =>
  createPostgresInstallationConfigStore(
    drizzle(client, { schema }),
  ).importValue(key, value);

function stores() {
  const calls: string[] = [];
  return {
    calls,
    connect: async () => ({
      db: drizzle(client, { schema }),
      objects: {
        get: async () => undefined,
        hold: async () => {
          calls.push("hold");
        },
        putImmutable: async () => {
          calls.push("put");
          return { outcome: "created" as const, version: "v1" };
        },
      },
      close: async () => {
        calls.push("close");
      },
    }),
  };
}

test.each([
  [{ CHECKPOINT_OBJECT_STORE: "disabled" }, "CHECKPOINT_OBJECT_STORE=disabled"],
  [
    { ...s3, CHECKPOINT_OBJECT_PROTECTION: "unversioned" },
    "CHECKPOINT_OBJECT_PROTECTION=unversioned cannot hold archived events",
  ],
])(
  "exits 0 without connecting when it cannot archive: %p",
  async (environment, reason) => {
    const log = logger();
    const { calls, connect } = stores();
    expect(await runSessionArchive({ connect, environment, logger: log })).toBe(
      0,
    );
    expect(calls).toEqual([]);
    expect(log.lines).toEqual([
      { message: "Session archive skipped", fields: { reason } },
    ]);
  },
);

test("restore is refused where nothing could have been archived", async () => {
  await expect(
    runSessionArchive({
      argv: ["restore", "00000000-0000-0000-0000-000000000001"],
      environment: { CHECKPOINT_OBJECT_STORE: "disabled" },
      logger: logger(),
    }),
  ).rejects.toThrow("Cannot restore archived events");
});

test.each([[["purge"]], [["restore"]], [["restore", "a", "b"]]])(
  "an unknown command line is refused: %p",
  async (argv) => {
    await expect(
      runSessionArchive({ argv, environment: locked, logger: logger() }),
    ).rejects.toThrow("Usage: session-archive.ts");
  },
);

test("with nothing saved it is a dry run at 180 days", async () => {
  const log = logger();
  const { calls, connect } = stores();
  const code = await runSessionArchive({
    connect,
    environment: running,
    logger: log,
  });
  expect(code).toBe(0);
  expect(calls).toEqual(["close"]);
  expect(log.lines.at(-1)).toEqual({
    message: "Session archive completed",
    fields: {
      after_days: 180,
      bytes: 0,
      chunks: 0,
      dry_run: true,
      events: 0,
      failed: 0,
      sessions: 0,
    },
  });
});

test("archives with the saved days and dry run, never the env's", async () => {
  await saved("session_archive_after_days", 30);
  await saved("session_archive_dry_run", false);
  const log = logger();
  const { connect } = stores();
  const code = await runSessionArchive({
    connect,
    environment: {
      ...running,
      SESSION_ARCHIVE_AFTER_DAYS: "90",
      SESSION_ARCHIVE_DRY_RUN: "true",
    } as typeof running,
    logger: log,
  });
  expect(code).toBe(0);
  expect(log.lines.at(-1)?.fields).toMatchObject({
    after_days: 30,
    dry_run: false,
  });
});

test("a saved 0 skips archiving after the read", async () => {
  await saved("session_archive_after_days", 0);
  const log = logger();
  const { calls, connect } = stores();
  expect(
    await runSessionArchive({ connect, environment: running, logger: log }),
  ).toBe(0);
  expect(calls).toEqual(["close"]);
  expect(log.lines.at(-1)).toEqual({
    message: "Session archive skipped",
    fields: { reason: "session_archive_after_days is 0" },
  });
});

test.each([
  "session_archive_after_days",
  "session_archive_dry_run",
])("a blocked %s refuses the whole run and names only the key", async (key) => {
  await saved(key, { refused_env: "X" });
  const log = logger();
  const { calls, connect } = stores();
  expect(
    await runSessionArchive({ connect, environment: running, logger: log }),
  ).toBe(1);
  expect(calls).toEqual(["close"]);
  expect(log.lines.at(-1)).toEqual({
    message: "Session archive refused: its settings cannot be read",
    fields: {
      error: `${key} has no value this release accepts; save it in Settings > Workspace > Execution limits`,
      setting: key,
    },
  });
});

test("settings that cannot be read refuse the run", async () => {
  const log = logger();
  const closed: string[] = [];
  const code = await runSessionArchive({
    connect: async () => ({
      db: {
        select: () => {
          throw new Error("connection refused");
        },
      } as never,
      objects: {
        get: async () => undefined,
        hold: async () => undefined,
        putImmutable: async () => ({
          outcome: "created" as const,
          version: "v1",
        }),
      },
      close: async () => {
        closed.push("close");
      },
    }),
    environment: running,
    logger: log,
  });
  expect(code).toBe(1);
  expect(closed).toEqual(["close"]);
  expect(log.lines.at(-1)).toMatchObject({
    message: "Session archive refused: its settings cannot be read",
    fields: { setting: null },
  });
});

test("restore runs whatever the settings say", async () => {
  await saved("session_archive_after_days", { refused_env: "X" });
  const log = logger();
  const { connect } = stores();
  const sessionId = "00000000-0000-0000-0000-000000000001";
  expect(
    await runSessionArchive({
      argv: ["restore", sessionId],
      connect,
      environment: running,
      logger: log,
    }),
  ).toBe(0);
  expect(log.lines.at(-1)).toEqual({
    message: "Session archive restored",
    fields: { chunks: 0, events: 0, session_id: sessionId },
  });
});
