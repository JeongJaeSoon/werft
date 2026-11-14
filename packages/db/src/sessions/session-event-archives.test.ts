import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { InvalidCursorError } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/pglite";
import { createPostgresSessionReader } from "../postgres-unit-of-work.ts";
import type { Database } from "../queries.ts";
import * as schema from "../schema.ts";
import { createPostgresUsageReader } from "../usage-reader.ts";
import { encodeEventCursor } from "./cursors.ts";
import { readSessionActivity } from "./session-activity.ts";
import {
  ARCHIVE_CHUNK_EVENTS,
  type ArchiveChunkRow,
  type ArchiveObjectStore,
  archiveSessionEvents,
  createArchivedEventCache,
  decodeArchiveChunk,
  encodeArchiveChunk,
  restoreSessionEvents,
  SESSION_ARCHIVE_PREFIX,
} from "./session-event-archives.ts";
import { streamClock } from "./session-events.ts";

const OWNER = "owner-archive";

type StoredObject = {
  body: Uint8Array;
  version: string;
  held: boolean;
};

/** A versioned, create-only bucket; `fail` makes the named step throw. */
function memoryBucket() {
  const objects = new Map<string, StoredObject[]>();
  const bucket = {
    objects,
    fail: undefined as undefined | "put" | "duplicate" | "hold" | "get",
    tamper: false,
    async putImmutable(key: string, body: Uint8Array) {
      if (bucket.fail === "put") throw new Error("put refused");
      if (bucket.fail === "duplicate") return { outcome: "duplicate" as const };
      if (objects.has(key)) return { outcome: "conflict" as const };
      const version = crypto.randomUUID();
      objects.set(key, [{ body: body.slice(), version, held: false }]);
      return { outcome: "created" as const, version };
    },
    async hold(key: string, version: string) {
      if (bucket.fail === "hold") throw new Error("hold refused");
      const found = objects.get(key)?.find((o) => o.version === version);
      if (!found) throw new Error("no such version");
      found.held = true;
    },
    async get(key: string, version?: string) {
      if (bucket.fail === "get") throw new Error("get refused");
      const found = objects
        .get(key)
        ?.find((o) => version === undefined || o.version === version);
      if (!found) return undefined;
      if (bucket.tamper) {
        const changed = found.body.slice();
        changed.set([(changed.at(-1) ?? 0) ^ 1], changed.length - 1);
        return changed;
      }
      return found.body;
    },
  };
  return bucket satisfies ArchiveObjectStore;
}

let client: PGlite;
let db: Database;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema }) as unknown as Database;
});

afterEach(async () => {
  await client.close();
});

const rows = async <T>(query: string, params: unknown[] = []) =>
  (await client.query<T>(query, params)).rows;

/** Both projection cursors past every event, as a caught-up reconciler leaves them. */
async function projectionsCaughtUp(through = 9_000_000_000) {
  await client.query(
    `INSERT INTO tool_call_progress (id, applied_through) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET applied_through = excluded.applied_through`,
    [through],
  );
  await client.query(
    `INSERT INTO neutral_field_progress (id, filled_through, history_through) VALUES (1, $1, 0)
     ON CONFLICT (id) DO UPDATE SET filled_through = excluded.filled_through`,
    [through],
  );
}

async function session(daysIdle = 200): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch, status, created_at, last_turn_at)
     VALUES ($1, $2, 'https://example.invalid/r.git', 'main', 'idle',
             now() - make_interval(days => $3 + 1), now() - make_interval(days => $3))`,
    [id, OWNER, daysIdle],
  );
  await client.query(
    `INSERT INTO turns (session_id, sequence, message, status)
     VALUES ($1, 1, 'first', 'succeeded'), ($1, 2, 'second', 'succeeded')`,
    [id],
  );
  return id;
}

/**
 * `count` events of every shape a page reads: tool calls and results,
 * neutral fields beside the payload, no occurred_at, a turn or none, and
 * payload values a JavaScript round trip would change.
 */
async function seedEvents(sessionId: string, count: number, from = 1) {
  await client.query(
    `INSERT INTO events (session_id, type, payload, neutral, turn_id, attempt_id,
                         source_sequence, occurred_at, created_at)
     SELECT $1,
            CASE e % 5 WHEN 1 THEN 'tool_use' WHEN 2 THEN 'tool_result'
                       WHEN 3 THEN 'status' ELSE 'assistant' END,
            CASE e % 5
              WHEN 1 THEN jsonb_build_object('type', 'assistant', 'parent_tool_use_id', null,
                'message', jsonb_build_object('content', jsonb_build_array(jsonb_build_object(
                  'type', 'tool_use', 'id', 'u' || e, 'name', 'Bash',
                  'input', jsonb_build_object('command', 'bun test ' || e)))))
              WHEN 2 THEN jsonb_build_object('tool_use_id', 'u' || (e - 1),
                'is_error', e % 7 = 2, 'content', repeat('y', 300))
              WHEN 3 THEN jsonb_build_object('phase', 'running')
              ELSE ('{"type": "assistant", "parent_tool_use_id": null, "big": 12345678901234567890123,'
                    || ' "precise": 0.10000000000000000555, "message": {"content": [{"type": "text",'
                    || ' "text": "줄 ' || e || ' 😀\\n둘째 줄"}]}}')::jsonb
            END,
            CASE WHEN e % 3 = 0
                 THEN jsonb_build_object('text', 'neutral ' || e) END,
            CASE WHEN e % 4 = 0 THEN NULL
                 ELSE (SELECT id FROM turns WHERE session_id = $1 ORDER BY sequence LIMIT 1) END,
            CASE WHEN e % 4 = 0 THEN NULL ELSE 'att-' || $1 END,
            CASE WHEN e % 4 = 0 THEN NULL ELSE e END,
            CASE WHEN e % 6 = 0 THEN NULL
                 ELSE now() - interval '300 days' + e * interval '1.234567 seconds' END,
            now() - interval '300 days' + e * interval '1.234568 seconds'
     FROM generate_series($2::int, $2::int + $3::int - 1) e`,
    [sessionId, from, count],
  );
}

const reader = (store?: ArchiveObjectStore) =>
  createPostgresSessionReader(
    db,
    store === undefined ? {} : { archivedEvents: store },
  );

/** Every page from `after`, as the SSE route reads them. */
async function allPages(
  sessionId: string,
  store?: ArchiveObjectStore,
  after?: string,
  limit = 37,
  maxBytes = 9_000,
) {
  const pages = [];
  let cursor = after;
  for (;;) {
    const page = await reader(store).readEvents(OWNER, sessionId, {
      ...(cursor === undefined ? {} : { after: cursor }),
      limit,
      maxBytes,
    });
    if (!page) throw new Error("session not visible");
    pages.push(page);
    const last = page.items.at(-1);
    if (!page.more || last === undefined) break;
    cursor = last.id;
  }
  return JSON.stringify(pages);
}

const eventRows = (sessionId: string) =>
  rows<{ row: string }>(
    `SELECT row_to_json(e)::text AS row FROM events e WHERE session_id = $1 ORDER BY id`,
    [sessionId],
  );

const detail = async (sessionId: string, store?: ArchiveObjectStore) => {
  const found = await reader(store).getSession(OWNER, sessionId);
  return {
    last_event_at: found?.last_event_at,
    activity: (await readSessionActivity(db, [sessionId])).get(sessionId),
  };
};

const otherTables = () =>
  rows<{ counts: string }>(`SELECT json_build_object(
    'sessions', (SELECT count(*) FROM sessions),
    'turns', (SELECT count(*) FROM turns),
    'tool_calls', (SELECT count(*) FROM tool_calls),
    'provider_usage', (SELECT count(*) FROM provider_usage),
    'pending_requests', (SELECT count(*) FROM pending_requests),
    'session_outcomes', (SELECT count(*) FROM session_outcomes))::text AS counts`);

const archive = (
  store: ArchiveObjectStore,
  options: { afterDays?: number; dryRun?: boolean } = {},
) =>
  archiveSessionEvents(db, store, {
    afterDays: options.afterDays ?? 180,
    dryRun: options.dryRun ?? false,
    batchSize: 2,
  });

describe("session event archiving", () => {
  test("reads the same pages, cursors, list time, activity and clock after archiving, and restores the same rows", async () => {
    await projectionsCaughtUp();
    const id = await session();
    await seedEvents(id, 2_345);
    const original = await eventRows(id);
    const middle = JSON.parse(await allPages(id))[20].items.at(-1).id as string;
    const before = {
      pages: await allPages(id),
      fromMiddle: await allPages(id, undefined, middle),
      wide: await allPages(id, undefined, undefined, 100, 1_048_576),
      detail: await detail(id),
      clock: (await streamClock(db, id))?.toISOString(),
      others: await otherTables(),
    };

    const store = memoryBucket();
    const totals = await archive(store);
    expect(totals).toMatchObject({
      sessions: 1,
      events: 2_345,
      chunks: Math.ceil(2_345 / ARCHIVE_CHUNK_EVENTS),
      failed: 0,
    });
    expect(await eventRows(id)).toEqual([]);
    const chunks = await rows<{
      from_id: string;
      through_id: string;
      object_key: string;
      version_id: string;
      sha256: string;
      event_count: number;
      bytes: string;
    }>(
      `SELECT from_id, through_id, object_key, version_id, sha256, event_count, bytes
       FROM session_event_archives WHERE session_id = $1 ORDER BY from_id`,
      [id],
    );
    expect(chunks.map((chunk) => chunk.event_count)).toEqual([1000, 1000, 345]);
    for (const chunk of chunks) {
      expect(chunk.object_key).toMatch(
        new RegExp(
          `^${SESSION_ARCHIVE_PREFIX}${id}/events-${chunk.from_id}-${chunk.through_id}-[0-9a-f]{16}\\.jsonl\\.gz$`,
        ),
      );
      const [object] = store.objects.get(chunk.object_key) ?? [];
      expect(object?.held).toBe(true);
      expect(object?.version).toBe(chunk.version_id);
      expect(Number(chunk.bytes)).toBe(object?.body.byteLength ?? -1);
      expect(
        createHash("sha256")
          .update(object?.body ?? new Uint8Array())
          .digest("hex"),
      ).toBe(chunk.sha256);
      const line = JSON.parse(
        decodeArchiveChunk(object?.body ?? new Uint8Array())[0] ?? "{}",
      );
      expect(Object.keys(line).sort()).toEqual([
        "attempt_id",
        "created_at",
        "id",
        "neutral",
        "occurred_at",
        "payload",
        "source_sequence",
        "turn_id",
        "type",
      ]);
    }

    const usage = await createPostgresUsageReader(db).installationUsage();
    expect(usage.archivedEventsBytes).toBe(
      chunks.reduce((sum, chunk) => sum + Number(chunk.bytes), 0),
    );
    expect(usage.archivedEventsUpdatedAt).toBeInstanceOf(Date);

    expect(await allPages(id, store)).toBe(before.pages);
    expect(await allPages(id, store, middle)).toBe(before.fromMiddle);
    expect(await allPages(id, store, undefined, 100, 1_048_576)).toBe(
      before.wide,
    );
    expect(await detail(id, store)).toEqual(before.detail);
    expect((await streamClock(db, id))?.toISOString()).toBe(before.clock);
    expect(await otherTables()).toEqual(before.others);
    // Read without the bucket, an archived session fails loudly rather than
    // reading as empty.
    expect(allPages(id)).rejects.toThrow(/archived events/);

    expect(await restoreSessionEvents(db, store, id)).toEqual({
      chunks: 3,
      events: 2_345,
    });
    expect(await eventRows(id)).toEqual(original);
    expect(await allPages(id)).toBe(before.pages);
    expect(
      await rows(`SELECT 1 FROM session_event_archives WHERE session_id = $1`, [
        id,
      ]),
    ).toEqual([]);
  });

  test("a tail written after archiving reads on, and archives as a new chunk", async () => {
    await projectionsCaughtUp();
    const id = await session();
    await seedEvents(id, 300);
    const store = memoryBucket();
    await archive(store);
    const archivedPages = JSON.parse(await allPages(id, store)) as {
      items: { id: string }[];
    }[];
    const lastArchived = archivedPages.at(-1)?.items.at(-1)?.id as string;

    await seedEvents(id, 40, 301);
    const withTail = await allPages(id, store);
    const fromLastArchived = await allPages(id, store, lastArchived);
    const tailIds = (await eventRows(id)).length;
    expect(tailIds).toBe(40);
    const flat = (pages: string) =>
      (JSON.parse(pages) as { items: unknown[] }[]).flatMap(
        (page) => page.items,
      );
    expect(flat(withTail)).toHaveLength(340);
    expect(flat(fromLastArchived)).toEqual(flat(withTail).slice(300));
    const tailDetail = await detail(id, store);
    expect(tailDetail.activity?.window.complete).toBe(false);
    expect(tailDetail.activity?.window.events).toBe(340);

    await client.query(
      `UPDATE sessions SET last_turn_at = now() - interval '200 days' WHERE id = $1`,
      [id],
    );
    const before = { pages: withTail, detail: await detail(id, store) };
    const totals = await archive(store);
    expect(totals).toMatchObject({ sessions: 1, events: 40, chunks: 1 });
    expect(await eventRows(id)).toEqual([]);
    expect(await allPages(id, store)).toBe(before.pages);
    expect(await detail(id, store)).toEqual(before.detail);
  });

  test("leaves sessions alone that are recent, running, waiting, pushing or past the projections", async () => {
    await projectionsCaughtUp();
    const recent = await session(100);
    const running = await session();
    const waiting = await session();
    const pushing = await session();
    const beyond = await session();
    for (const id of [recent, running, waiting, pushing, beyond]) {
      await seedEvents(id, 20);
    }
    await client.query(
      `INSERT INTO turns (session_id, sequence, message, status) VALUES ($1, 3, 'busy', 'running')`,
      [running],
    );
    await client.query(`SET session_replication_role = replica`);
    await client.query(
      `INSERT INTO pending_requests (request_id, session_id, turn_id, attempt_id, kind, payload, input_hash, expires_at)
       SELECT 'req-1', $1, id, 'att', 'permission', '{}', 'h', now() + interval '1 day'
       FROM turns WHERE session_id = $1 LIMIT 1`,
      [waiting],
    );
    await client.query(
      `INSERT INTO push_requests (id, owner_id, session_id, repository_id, checkpoint_revision, git_commit, target_branch, state, requested_by, request_receipt_id)
       VALUES ($1, $2, $3::uuid, 'repo', 1, repeat('a', 40), 'agent/' || $3::text, 'requested', '{}', $1)`,
      [crypto.randomUUID(), OWNER, pushing],
    );
    await client.query(`SET session_replication_role = origin`);
    // The projections have read up to the beyond session's tenth event.
    const [tenth] = await rows<{ id: string }>(
      `SELECT id FROM events WHERE session_id = $1 ORDER BY id OFFSET 9 LIMIT 1`,
      [beyond],
    );
    await client.query(
      `DELETE FROM events WHERE session_id <> $1 AND id > $2`,
      [beyond, tenth?.id],
    );
    await projectionsCaughtUp(Number(tenth?.id));

    const results = new Map<string, unknown>();
    const pass = () =>
      archiveSessionEvents(db, memoryBucket(), {
        afterDays: 180,
        dryRun: false,
        batchSize: 10,
        onSession: (id, result) => results.set(id, result),
      });
    await pass();
    expect([...results.keys()]).toEqual([]);
    expect(await eventRows(beyond)).toHaveLength(20);

    await projectionsCaughtUp();
    await pass();
    expect([...results.keys()]).toEqual([beyond]);
    expect(results.get(beyond)).toMatchObject({
      status: "archived",
      events: 20,
    });
    expect(await eventRows(beyond)).toHaveLength(0);
    for (const id of [recent, running, waiting, pushing]) {
      expect(
        await rows(
          `SELECT 1 FROM session_event_archives WHERE session_id = $1`,
          [id],
        ),
      ).toEqual([]);
    }
  });

  test("a dry run counts what would move and changes nothing; zero days does nothing at all", async () => {
    await projectionsCaughtUp();
    const id = await session();
    await seedEvents(id, 50);
    const original = await eventRows(id);
    const store = memoryBucket();
    const planned = await archive(store, { dryRun: true });
    const [{ bytes } = { bytes: "0" }] = await rows<{ bytes: string }>(
      `SELECT sum(octet_length(json_build_object('id', e.id, 'type', e.type, 'payload', e.payload,
         'neutral', e.neutral, 'turn_id', e.turn_id, 'attempt_id', e.attempt_id,
         'source_sequence', e.source_sequence, 'occurred_at', e.occurred_at,
         'created_at', e.created_at)::text) + 1) AS bytes
       FROM events e WHERE session_id = $1`,
      [id],
    );
    expect(planned).toEqual({
      sessions: 1,
      events: 50,
      bytes: Number(bytes),
      chunks: 0,
      failed: 0,
    });
    expect(await archive(store, { afterDays: 0 })).toEqual({
      sessions: 0,
      events: 0,
      bytes: 0,
      chunks: 0,
      failed: 0,
    });
    expect(store.objects.size).toBe(0);
    expect(await eventRows(id)).toEqual(original);
  });

  for (const step of ["put", "duplicate", "hold", "get"] as const) {
    test(`a failed ${step} deletes no event`, async () => {
      await projectionsCaughtUp();
      const id = await session();
      await seedEvents(id, 30);
      const original = await eventRows(id);
      const store = memoryBucket();
      store.fail = step;
      const totals = await archive(store);
      expect(totals.failed).toBe(1);
      expect(await eventRows(id)).toEqual(original);
      expect(await rows(`SELECT 1 FROM session_event_archives`)).toEqual([]);
    });
  }

  test("an object that reads back different deletes no event", async () => {
    await projectionsCaughtUp();
    const id = await session();
    await seedEvents(id, 30);
    const original = await eventRows(id);
    const store = memoryBucket();
    store.tamper = true;
    expect((await archive(store)).failed).toBe(1);
    expect(await eventRows(id)).toEqual(original);
  });

  test("rows that changed under the pass are not deleted", async () => {
    await projectionsCaughtUp();
    const id = await session();
    await seedEvents(id, 30);
    const store = memoryBucket();
    const hold = store.hold;
    // Another writer takes an archived row away between the read and the commit.
    store.hold = async (key, version) => {
      await hold(key, version);
      await client.query(
        `DELETE FROM events WHERE id = (SELECT min(id) + 1 FROM events WHERE session_id = $1)`,
        [id],
      );
    };
    const left = (await eventRows(id)).length - 1;
    expect((await archive(store)).failed).toBe(1);
    expect(await eventRows(id)).toHaveLength(left);
    expect(await rows(`SELECT 1 FROM session_event_archives`)).toEqual([]);
  });

  test("a cursor that names no row of the session, archived or not, is refused", async () => {
    await projectionsCaughtUp();
    const id = await session();
    const other = await session(10);
    await seedEvents(id, 10);
    await seedEvents(other, 5);
    await seedEvents(id, 10, 11);
    // Inside the archived chunk's id range, yet another session's.
    const [foreign] = await rows<{ id: string }>(
      `SELECT id FROM events WHERE session_id = $1 LIMIT 1`,
      [other],
    );
    const [own] = await rows<{ id: string }>(
      `SELECT id FROM events WHERE session_id = $1 ORDER BY id OFFSET 12 LIMIT 1`,
      [id],
    );
    const store = memoryBucket();
    await archive(store);
    expect(
      await rows(`SELECT 1 FROM session_event_archives WHERE session_id = $1`, [
        id,
      ]),
    ).toHaveLength(1);
    const read = (after: number) =>
      reader(store).readEvents(OWNER, id, {
        after: encodeEventCursor(after),
        limit: 10,
        maxBytes: 100_000,
      });
    await expect(read(Number(foreign?.id))).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
    expect((await read(Number(own?.id)))?.items).toHaveLength(7);
  });

  test.each(["archive", "restore"] as const)(
    "a page read while a pass commits (%s) neither drops nor repeats rows",
    async (move) => {
      await projectionsCaughtUp();
      const id = await session();
      await seedEvents(id, 20);
      const store = memoryBucket();
      if (move === "restore") await archive(store);
      const settled = await allPages(id, store, undefined, 50, 1_000_000);
      // The move commits just before the page query, after the reader has
      // taken the session's chunk list.
      let fired = false;
      const racing = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "execute") return Reflect.get(target, prop, receiver);
          return async (query: Parameters<Database["execute"]>[0]) => {
            const text = new PgDialect().sqlToQuery(query as SQL).sql;
            if (!fired && text.includes("running_bytes")) {
              fired = true;
              if (move === "archive") await archive(store);
              else await restoreSessionEvents(db, store, id);
            }
            return target.execute(query);
          };
        },
      });
      const page = await createPostgresSessionReader(racing, {
        archivedEvents: store,
      }).readEvents(OWNER, id, { limit: 50, maxBytes: 1_000_000 });
      expect(fired).toBe(true);
      expect(JSON.stringify([page])).toBe(settled);
    },
  );
});

describe("a session that wakes during a pass", () => {
  test.each(["listed", "held"] as const)(
    "keeps its events when a turn starts after it was %s",
    async (moment) => {
      await projectionsCaughtUp();
      const id = await session();
      await seedEvents(id, 20);
      const store = memoryBucket();
      const wake = () =>
        client.query(
          `INSERT INTO turns (session_id, sequence, message, status) VALUES ($1, 3, 'again', 'queued')`,
          [id],
        );
      if (moment === "held") {
        const hold = store.hold.bind(store);
        store.hold = async (...args: Parameters<typeof hold>) => {
          await hold(...args);
          await wake();
        };
      }
      let woke = false;
      const waking = new Proxy(db, {
        get(target, prop, receiver) {
          if (prop !== "execute") return Reflect.get(target, prop, receiver);
          return async (query: Parameters<Database["execute"]>[0]) => {
            const result = await target.execute(query);
            const text = new PgDialect().sqlToQuery(query as SQL).sql;
            if (
              moment === "listed" &&
              !woke &&
              text.includes("make_interval")
            ) {
              woke = true;
              await wake();
            }
            return result;
          };
        },
      });
      const results = new Map<string, unknown>();
      await archiveSessionEvents(waking, store, {
        afterDays: 180,
        dryRun: false,
        batchSize: 10,
        onSession: (sid, result) => results.set(sid, result),
      });
      expect(results.get(id)).toMatchObject({ status: "archived", events: 0 });
      expect(await eventRows(id)).toHaveLength(20);
      expect(
        await rows(
          `SELECT 1 FROM session_event_archives WHERE session_id = $1`,
          [id],
        ),
      ).toEqual([]);
    },
  );
});

describe("archived event cache", () => {
  test("two readers missing one chunk at once count its bytes once", async () => {
    const line = (id: number) => JSON.stringify({ id, pad: "x".repeat(90) });
    const bodies = new Map([
      ["a", encodeArchiveChunk([line(1)])],
      ["b", encodeArchiveChunk([line(2)])],
    ]);
    const reads: string[] = [];
    const cache = createArchivedEventCache(
      {
        async get(key) {
          reads.push(key);
          return bodies.get(key);
        },
      },
      2 * line(1).length,
    );
    const chunk = (key: string, id: number): ArchiveChunkRow => ({
      fromId: id,
      throughId: id,
      objectKey: key,
      versionId: "v1",
      sha256: createHash("sha256")
        .update(bodies.get(key) ?? new Uint8Array())
        .digest("hex"),
      eventCount: 1,
    });

    await Promise.all([cache.lines(chunk("a", 1)), cache.lines(chunk("a", 1))]);
    await cache.lines(chunk("b", 2));
    await cache.lines(chunk("a", 1));
    expect(reads).toEqual(["a", "a", "b"]);
  });
});
