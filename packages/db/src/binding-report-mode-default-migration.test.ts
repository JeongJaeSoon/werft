import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { reportModeOf, reportsTurns } from "./link-posting.ts";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER } from "./migration-journal.ts";
import type { Database } from "./queries.ts";
import { rowsOf } from "./statement-rows.ts";
import {
  BINDING_REPORT_MODE_DEFAULT,
  migrationsThrough,
} from "./testing/migrations-through.ts";

let client: PGlite;
let db: Database;
let before: string;
const agentId = randomUUID();
const binding = {
  stored: randomUUID(),
  notifyOnly: randomUUID(),
  progress: randomUUID(),
};

const insertBinding = (id: string, reportMode: string) =>
  client.query(
    `INSERT INTO surface_bindings (id, workspace_id, agent_id, surface, mode,
       ceiling_actions, ceiling_disclosure, report_mode)
     VALUES ($1, $2, $3, 'web', 'on', '{}', 'full', $4)`,
    [id, randomUUID(), agentId, reportMode],
  );

const insertLink = (
  name: string,
  bindingId: string,
  columns: { reportMode?: string; visibility?: string; closed?: boolean } = {},
) =>
  client.query(
    `INSERT INTO session_links (id, workspace_id, owner_id, installation_id,
       surface_binding_id, surface_ref, channel_id, thread_id, opened_by_ts,
       agent_id, release_id, report_mode, visibility, closed_at, closed_reason)
     VALUES ($1, $2, 'owner', $3, $4, $5, 'C1', $6, $6, $7, 'r1', $8,
       coalesce($9, 'full'), $10, $11)`,
    [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      bindingId,
      `T1:C1:${name}`,
      name,
      agentId,
      columns.reportMode ?? null,
      columns.visibility ?? null,
      columns.closed ? new Date() : null,
      columns.closed ? "completed" : null,
    ],
  );

// Every link's stored value and its thread, by name.
const links = async () =>
  rowsOf<{ thread: string; stored: string | null }>(
    await db.execute(sql`
      SELECT thread_id AS thread, report_mode AS stored
      FROM session_links ORDER BY thread_id
    `),
  );
const bindings = async () =>
  rowsOf<{ report_mode: string | null; bindings: number }>(
    await db.execute(sql`
      SELECT report_mode, count(*)::int AS bindings FROM surface_bindings
      GROUP BY 1 ORDER BY 1 NULLS FIRST
    `),
  );

let linksBefore: Awaited<ReturnType<typeof links>>;
let bindingsBefore: Awaited<ReturnType<typeof bindings>>;

beforeAll(async () => {
  client = new PGlite();
  before = migrationsThrough(BINDING_REPORT_MODE_DEFAULT, { exclusive: true });
  await migrate(drizzle(client), { migrationsFolder: before });
  db = drizzle(client) as unknown as Database;
  // The rows a binding or link names are not what is under test.
  await client.exec("SET session_replication_role = replica");
  await client.query(
    "INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'a', 'a', $3)",
    [agentId, randomUUID(), randomUUID()],
  );
  // per_step is what 0326 stored for every channel; nothing wrote the
  // others, but a value a person picks must come through as it is.
  await insertBinding(binding.stored, "per_step");
  await insertBinding(binding.notifyOnly, "notify_only");
  await insertBinding(binding.progress, "progress");
  await insertLink("a-open-unset", binding.stored);
  await insertLink("b-open-none", binding.stored, { reportMode: "none" });
  await insertLink("c-open-per-step", binding.stored, {
    reportMode: "per_step",
  });
  await insertLink("d-open-progress", binding.stored, {
    reportMode: "progress",
  });
  await insertLink("e-closed-unset", binding.stored, { closed: true });
  await insertLink("f-unmoved-summary", binding.stored, {
    visibility: "summary",
  });
  await insertLink("g-open-unset-notify-only", binding.notifyOnly);
  await insertLink("h-open-unset-progress", binding.progress);
  linksBefore = await links();
  bindingsBefore = await bindings();
  await migrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
});

afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

describe("0395 binding report mode default", () => {
  test("the column takes null and has no default", async () => {
    const [column] = (
      await client.query<{ is_nullable: string; column_default: unknown }>(
        `SELECT is_nullable, column_default FROM information_schema.columns
         WHERE table_name = 'surface_bindings' AND column_name = 'report_mode'`,
      )
    ).rows;
    expect(column).toEqual({ is_nullable: "YES", column_default: null });
  });

  test("the stored per_step goes back to null; other bindings and every link keep theirs", async () => {
    expect(bindingsBefore).toEqual([
      { report_mode: "notify_only", bindings: 1 },
      { report_mode: "per_step", bindings: 1 },
      { report_mode: "progress", bindings: 1 },
    ]);
    expect(await bindings()).toEqual([
      { report_mode: null, bindings: 1 },
      { report_mode: "notify_only", bindings: 1 },
      { report_mode: "progress", bindings: 1 },
    ]);
    expect(await links()).toEqual(linksBefore);
  });

  test("every statement runs again on a database it already changed", async () => {
    const statements = readFileSync(
      join(MIGRATIONS_FOLDER, `${BINDING_REPORT_MODE_DEFAULT}.sql`),
      "utf8",
    ).split("--> statement-breakpoint");
    for (const statement of statements) await client.exec(statement);
    expect(await links()).toEqual(linksBefore);
  });

  // The same channel under each rollout: only what picks nothing moves.
  test.each([
    ["off", "per_step"],
    ["shadow", "per_step"],
    ["on", "progress"],
  ] as const)(
    "rollout %s: a thread that picks nothing reports %s",
    async (rollout, unset) => {
      await client.query(
        "UPDATE agents SET conversation_rollout = $1 WHERE id = $2",
        [rollout, agentId],
      );
      const read = rowsOf<{ thread: string; mode: string; reports: boolean }>(
        await db.execute(sql`
        SELECT l.thread_id AS thread, ${reportModeOf(sql.raw("l"))} AS mode,
          ${reportsTurns(sql.raw("l"))} AS reports
        FROM session_links l ORDER BY l.thread_id
      `),
      );
      expect(read).toEqual([
        { thread: "a-open-unset", mode: unset, reports: true },
        { thread: "b-open-none", mode: "none", reports: false },
        { thread: "c-open-per-step", mode: "per_step", reports: true },
        { thread: "d-open-progress", mode: "progress", reports: true },
        { thread: "e-closed-unset", mode: unset, reports: true },
        // An unmoved summary link stays silent whatever its mode reads.
        { thread: "f-unmoved-summary", mode: unset, reports: false },
        {
          thread: "g-open-unset-notify-only",
          mode: "notify_only",
          reports: true,
        },
        { thread: "h-open-unset-progress", mode: "progress", reports: true },
      ]);
    },
  );
});
