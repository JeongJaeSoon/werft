import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { asc, eq, sql } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { migrate } from "../migrate.ts";
import * as schema from "../schema.ts";
import { deletedSources, editedSources, workspaces } from "../schema.ts";
import {
  createPostgresSlackSourceMarkStore,
  purgeUnknownSlackSourceMarks,
  SLACK_SOURCE_MARK_UNKNOWN_RETENTION_MS,
} from "./slack-source-marks.ts";

const migrations = join(import.meta.dir, "../../migrations");
const AT = new Date("2026-11-23T01:00:00.000Z");
const MINUTE_MS = 60_000;

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let marks: ReturnType<typeof createPostgresSlackSourceMarkStore>;

beforeAll(async () => {
  client = new PGlite();
  db = drizzle(client, { schema });
  await migrate(db, { migrationsFolder: migrations });
  marks = createPostgresSlackSourceMarkStore(db);
});

afterAll(async () => {
  await client.close();
});

async function workspace() {
  const id = randomUUID();
  await db.insert(workspaces).values({ id, slug: `ws-${id}`, name: "ws" });
  return { workspaceId: id, teamId: "T0MARKS", channelId: "C0MARKS" };
}

const deletedOf = (workspaceId: string) =>
  db
    .select()
    .from(deletedSources)
    .where(eq(deletedSources.workspaceId, workspaceId))
    .orderBy(asc(deletedSources.ts));
const editedOf = (workspaceId: string) =>
  db
    .select()
    .from(editedSources)
    .where(eq(editedSources.workspaceId, workspaceId))
    .orderBy(asc(editedSources.ts));

const markedMinutesAgo = (
  table: typeof deletedSources | typeof editedSources,
  workspaceId: string,
  ts: string,
  minutes: number,
) =>
  db
    .update(table)
    .set({ markedAt: sql`now() - make_interval(mins => ${minutes})` })
    .where(sql`${table.workspaceId} = ${workspaceId} AND ${table.ts} = ${ts}`);

describe("Slack source marks", () => {
  test("the tables keep where a message was, when and (for a delete) why, nothing else", async () => {
    const found = await db.execute<{ table_name: string; column_name: string }>(
      sql`SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('deleted_sources', 'edited_sources')
        ORDER BY table_name, ordinal_position`,
    );
    expect(found.rows.map((r) => `${r.table_name}.${r.column_name}`)).toEqual([
      "deleted_sources.workspace_id",
      "deleted_sources.team_id",
      "deleted_sources.channel_id",
      "deleted_sources.ts",
      "deleted_sources.deleted_at",
      "deleted_sources.marked_at",
      "deleted_sources.reason",
      "edited_sources.workspace_id",
      "edited_sources.team_id",
      "edited_sources.channel_id",
      "edited_sources.ts",
      "edited_sources.edited_at",
      "edited_sources.marked_at",
    ]);
  });

  test("the same delete twice is one mark", async () => {
    const where = await workspace();
    const mark = { ...where, ts: "1792800000.000100", at: AT };
    expect(await marks.markDeleted(mark)).toBe("recorded");
    expect(
      await marks.markDeleted({ ...mark, at: new Date(AT.getTime() + 1000) }),
    ).toBe("duplicate");
    expect(await deletedOf(where.workspaceId)).toEqual([
      expect.objectContaining({ ...where, ts: mark.ts, deletedAt: AT }),
    ]);
  });

  test("edits of one message keep one mark at the latest edit", async () => {
    const where = await workspace();
    const ts = "1792800000.000200";
    const later = new Date(AT.getTime() + MINUTE_MS);
    expect(await marks.markEdited({ ...where, ts, at: later })).toBe(
      "recorded",
    );
    // Slack's retries come in any order.
    expect(await marks.markEdited({ ...where, ts, at: AT })).toBe("recorded");
    expect(await editedOf(where.workspaceId)).toEqual([
      expect.objectContaining({ ...where, ts, editedAt: later }),
    ]);
  });

  test("a delete replaces the edit mark, and a later edit leaves none", async () => {
    const where = await workspace();
    const ts = "1792800000.000300";
    await marks.markEdited({ ...where, ts, at: AT });
    expect(await marks.markDeleted({ ...where, ts, at: AT })).toBe("recorded");
    expect(await editedOf(where.workspaceId)).toEqual([]);
    expect(await marks.markEdited({ ...where, ts, at: AT })).toBe("deleted");
    expect(await editedOf(where.workspaceId)).toEqual([]);
    expect(await deletedOf(where.workspaceId)).toHaveLength(1);
  });

  test("marks nothing points at go once the buffer's lifetime and an hour have passed; known ones stay", async () => {
    const where = await workspace();
    const old = "1792800000.000400";
    const recent = "1792800000.000500";
    const known = "1792800000.000600";
    for (const ts of [old, recent, known]) {
      await marks.markDeleted({ ...where, ts, at: AT });
      await marks.markEdited({ ...where, ts: `${ts}9`, at: AT });
    }
    const retentionMinutes = SLACK_SOURCE_MARK_UNKNOWN_RETENTION_MS / MINUTE_MS;
    expect(retentionMinutes).toBe(70);
    for (const ts of [old, known]) {
      await markedMinutesAgo(deletedSources, where.workspaceId, ts, 71);
      await markedMinutesAgo(editedSources, where.workspaceId, `${ts}9`, 71);
    }
    await markedMinutesAgo(deletedSources, where.workspaceId, recent, 69);
    await markedMinutesAgo(editedSources, where.workspaceId, `${recent}9`, 69);
    // A stand-in for the records that will point at messages.
    const options = {
      limit: 100,
      known: (mark: { ts: ReturnType<typeof sql.raw> }) =>
        sql`${mark.ts} IN (${known}, ${`${known}9`})`,
    };

    expect(
      await purgeUnknownSlackSourceMarks(db, { ...options, dryRun: true }),
    ).toEqual({ deleted: 1, edited: 1 });
    expect(await deletedOf(where.workspaceId)).toHaveLength(3);
    expect(
      await purgeUnknownSlackSourceMarks(db, { ...options, dryRun: false }),
    ).toEqual({ deleted: 1, edited: 1 });
    expect((await deletedOf(where.workspaceId)).map((m) => m.ts)).toEqual([
      recent,
      known,
    ]);
    expect((await editedOf(where.workspaceId)).map((m) => m.ts)).toEqual([
      `${recent}9`,
      `${known}9`,
    ]);

    // A shortened retention, as in a test: the recent marks go too.
    expect(
      await purgeUnknownSlackSourceMarks(db, {
        ...options,
        dryRun: false,
        retentionMs: 60 * MINUTE_MS,
      }),
    ).toEqual({ deleted: 1, edited: 1 });
    expect((await deletedOf(where.workspaceId)).map((m) => m.ts)).toEqual([
      known,
    ]);
  });

  test("without a judgment every old mark is unknown", async () => {
    const where = await workspace();
    await marks.markDeleted({ ...where, ts: "1792800000.000700", at: AT });
    await markedMinutesAgo(
      deletedSources,
      where.workspaceId,
      "1792800000.000700",
      71,
    );
    const purged = await purgeUnknownSlackSourceMarks(db, {
      limit: 100,
      dryRun: false,
    });
    expect(purged.deleted).toBeGreaterThanOrEqual(1);
    expect(await deletedOf(where.workspaceId)).toEqual([]);
  });
});
