import { createHash, randomBytes } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  OPEN_PUSH_REQUEST_STATES,
  type SessionActivity,
} from "@werft-ai/contracts";
import { type SQL, sql } from "drizzle-orm";
import { rowsOf } from "../control-unit-of-work.ts";
import type { Database } from "../queries.ts";
import {
  events,
  neutralFieldProgress,
  pendingRequests,
  pushIntents,
  pushRequests,
  sessionEventArchives,
  sessions,
  toolCallProgress,
  turns,
} from "../schema.ts";
import { mergeActivity, readActivityRange } from "./session-activity.ts";

/**
 * Old sessions' events moved to the checkpoint bucket, one gzip
 * JSON Lines object per chunk under `session-archive/<session id>/`: outside
 * the `sessions/<id>/` prefix a worker's object route is confined to, so no
 * running worker can create or read an archive key, and outside what the
 * checkpoint collector lists, so it never releases one.
 *
 * A row leaves `events` only after its object was created, held, read back
 * at that version and found to hold exactly the rows written, and it leaves
 * in the transaction that records the chunk. Nothing here deletes an object.
 */

export const SESSION_ARCHIVE_PREFIX = "session-archive/";
export const ARCHIVE_CHUNK_EVENTS = 1000;
const ARCHIVE_CHUNK_BYTES = 8 * 1024 * 1024;

/** What archiving needs of the checkpoint object store. */
export type ArchiveObjectStore = {
  putImmutable(
    key: string,
    body: Uint8Array,
  ): Promise<{
    outcome: "created" | "duplicate" | "conflict";
    version?: string;
  }>;
  hold(key: string, version: string): Promise<void>;
  get(key: string, version?: string): Promise<Uint8Array | undefined>;
};

/** What reading an archived chunk needs. */
export type ArchivedEventSource = Pick<ArchiveObjectStore, "get">;

// One events row as stored, built by Postgres so payload numbers and
// microsecond timestamps keep the text the database holds; JSON text
// escapes newlines, so one row is one line.
const LINE = sql`json_build_object(
  'id', e.id, 'type', e.type, 'payload', e.payload, 'neutral', e.neutral,
  'turn_id', e.turn_id, 'attempt_id', e.attempt_id,
  'source_sequence', e.source_sequence, 'occurred_at', e.occurred_at,
  'created_at', e.created_at)::text`;

/** The rows of archived lines, as events rows Postgres reads back. */
export function archivedRows(lines: readonly string[]) {
  return sql`jsonb_array_elements_text(${JSON.stringify(lines)}::jsonb) AS u(line)
    CROSS JOIN LATERAL jsonb_populate_record(NULL::${events}, u.line::jsonb) AS r`;
}

export function encodeArchiveChunk(lines: readonly string[]): Uint8Array {
  return gzipSync(Buffer.from(`${lines.join("\n")}\n`, "utf8"));
}

export function decodeArchiveChunk(body: Uint8Array): string[] {
  return gunzipSync(body)
    .toString("utf8")
    .split("\n")
    .filter((line) => line !== "");
}

const sha256 = (body: Uint8Array) =>
  createHash("sha256").update(body).digest("hex");

function archiveObjectKey(
  sessionId: string,
  fromId: number,
  throughId: number,
): string {
  // The nonce keeps a database restored to before an archive from meeting
  // its own earlier key when it archives the same range again.
  const nonce = randomBytes(8).toString("hex");
  return `${SESSION_ARCHIVE_PREFIX}${sessionId}/events-${fromId}-${throughId}-${nonce}.jsonl.gz`;
}

export type ArchiveChunkRow = {
  fromId: number;
  throughId: number;
  objectKey: string;
  versionId: string;
  sha256: string;
  eventCount: number;
};

/**
 * Reads an archived chunk at its version and refuses one that is not what
 * was recorded. Lines come back with their event ids, in id order.
 */
async function readArchiveChunk(
  source: ArchivedEventSource,
  chunk: ArchiveChunkRow,
): Promise<{ id: number; line: string }[]> {
  const body = await source.get(chunk.objectKey, chunk.versionId);
  if (body === undefined) {
    throw new Error(
      `Archived events ${chunk.objectKey} (version ${chunk.versionId}) are missing from the bucket`,
    );
  }
  if (sha256(body) !== chunk.sha256) {
    throw new Error(
      `Archived events ${chunk.objectKey} (version ${chunk.versionId}) do not match their recorded sha256`,
    );
  }
  const lines = decodeArchiveChunk(body);
  if (lines.length !== chunk.eventCount) {
    throw new Error(
      `Archived events ${chunk.objectKey} hold ${lines.length} rows, ${chunk.eventCount} recorded`,
    );
  }
  return lines.map((line) => ({
    id: Number((JSON.parse(line) as { id: number }).id),
    line,
  }));
}

type ChunkRecord = {
  from_id: string;
  through_id: string;
  object_key: string;
  version_id: string;
  sha256: string;
  event_count: number;
};

const chunkOf = (row: ChunkRecord): ArchiveChunkRow => ({
  fromId: Number(row.from_id),
  throughId: Number(row.through_id),
  objectKey: row.object_key,
  versionId: row.version_id,
  sha256: row.sha256,
  eventCount: Number(row.event_count),
});

/** A session's chunks that hold an id past `after`, oldest first. */
export async function archiveChunksAfter(
  db: Database,
  sessionId: string,
  after: number,
): Promise<ArchiveChunkRow[]> {
  const rows = rowsOf<ChunkRecord>(
    await db.execute(sql`
      SELECT from_id, through_id, object_key, version_id, sha256, event_count
      FROM ${sessionEventArchives}
      WHERE session_id = ${sessionId} AND through_id > ${after}
      ORDER BY from_id`),
  );
  return rows.map(chunkOf);
}

export function sameChunks(
  a: readonly ArchiveChunkRow[],
  b: readonly ArchiveChunkRow[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (chunk, index) =>
        chunk.fromId === b[index]?.fromId &&
        chunk.versionId === b[index]?.versionId,
    )
  );
}

/** The chunk whose id range takes in `id`, if any. */
export async function archiveChunkHolding(
  db: Database,
  sessionId: string,
  id: number,
): Promise<ArchiveChunkRow | undefined> {
  const [row] = rowsOf<ChunkRecord>(
    await db.execute(sql`
      SELECT from_id, through_id, object_key, version_id, sha256, event_count
      FROM ${sessionEventArchives}
      WHERE session_id = ${sessionId} AND from_id <= ${id}
      ORDER BY from_id DESC LIMIT 1`),
  );
  return row === undefined || Number(row.through_id) < id
    ? undefined
    : chunkOf(row);
}

/**
 * Decoded chunks kept for readers: the console opens three streams of one
 * session at once, each paging through the same chunks.
 */
export function createArchivedEventCache(
  source: ArchivedEventSource,
  maxBytes = 32 * 1024 * 1024,
) {
  const cached = new Map<
    string,
    { bytes: number; lines: { id: number; line: string }[] }
  >();
  let total = 0;
  return {
    async lines(chunk: ArchiveChunkRow) {
      const key = `${chunk.objectKey}\n${chunk.versionId}`;
      const hit = cached.get(key);
      if (hit !== undefined) {
        cached.delete(key);
        cached.set(key, hit);
        return hit.lines;
      }
      const lines = await readArchiveChunk(source, chunk);
      const bytes = lines.reduce((sum, { line }) => sum + line.length, 0);
      // Concurrent misses of one chunk each land here; count it once.
      total -= cached.get(key)?.bytes ?? 0;
      cached.delete(key);
      cached.set(key, { bytes, lines });
      total += bytes;
      for (const [oldest, entry] of cached) {
        if (total <= maxBytes || oldest === key) break;
        cached.delete(oldest);
        total -= entry.bytes;
      }
      return lines;
    },
  };
}

export type ArchivedEventCache = ReturnType<typeof createArchivedEventCache>;

/**
 * The newest id both global projections have read: tool_calls and the
 * neutral fields are derived from events by id cursor and never look back.
 */
async function projectedThrough(db: Database): Promise<number> {
  const [row] = rowsOf<{ through: string | null }>(
    await db.execute(sql`
      SELECT least(
        (SELECT ${toolCallProgress.appliedThrough} FROM ${toolCallProgress} LIMIT 1),
        (SELECT ${neutralFieldProgress.filledThrough} FROM ${neutralFieldProgress} LIMIT 1)
      ) AS through`),
  );
  return Number(row?.through ?? 0);
}

const UNSETTLED_TURN_STATUSES = sql`('queued', 'running', 'needs_input', 'outcome_unknown')`;

/**
 * Nothing running or waiting on anyone in the session, and the projections
 * have passed every event it has, so its stored activity is the window over
 * all of them.
 */
function settled(sessionId: SQL, cap: number): SQL {
  const openPush = sql.join(
    OPEN_PUSH_REQUEST_STATES.map((state) => sql`${state}`),
    sql`, `,
  );
  return sql`NOT EXISTS (SELECT 1 FROM ${turns} t
      WHERE t.session_id = ${sessionId} AND t.status IN ${UNSETTLED_TURN_STATUSES})
    AND NOT EXISTS (SELECT 1 FROM ${pendingRequests} r
      WHERE r.session_id = ${sessionId} AND r.resolved_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM ${pushRequests} p
      WHERE p.session_id = ${sessionId} AND p.state IN (${openPush}))
    AND NOT EXISTS (SELECT 1 FROM ${pushIntents} i
      WHERE i.session_id = ${sessionId} AND i.status IN ('deferred', 'pinned'))
    AND NOT EXISTS (SELECT 1 FROM ${events} e
      WHERE e.session_id = ${sessionId} AND e.id > ${cap})`;
}

/**
 * Sessions whose events may be archived: no activity for `afterDays`,
 * nothing running or waiting on anyone, an event past their last chunk, and
 * none past `cap`. A page of `limit`, ids after `afterId`.
 */
async function archivableSessions(
  db: Database,
  input: { afterDays: number; cap: number; afterId: string; limit: number },
): Promise<{ id: string; after: number }[]> {
  const rows = rowsOf<{ id: string; after: string }>(
    await db.execute(sql`
      SELECT s.id::text AS id, coalesce(a.through_id, 0) AS after
      FROM ${sessions} s
      LEFT JOIN LATERAL (
        SELECT through_id FROM ${sessionEventArchives}
        WHERE session_id = s.id ORDER BY from_id DESC LIMIT 1
      ) a ON true
      WHERE s.id > ${input.afterId}::uuid
        AND coalesce(s.last_turn_at, s.created_at)
          < statement_timestamp() - make_interval(days => ${input.afterDays}::int)
        AND ${settled(sql`s.id`, input.cap)}
        AND EXISTS (SELECT 1 FROM ${events} e
          WHERE e.session_id = s.id
            AND e.id > coalesce(a.through_id, 0) AND e.id <= ${input.cap})
      ORDER BY s.id
      LIMIT ${input.limit}`),
  );
  return rows.map((row) => ({ id: row.id, after: Number(row.after) }));
}

type Head = {
  through_id: string;
  activity: SessionActivity;
  activity_through: string;
};

async function lastChunk(
  db: Database,
  sessionId: string,
): Promise<Head | undefined> {
  const [row] = rowsOf<Head>(
    await db.execute(sql`
      SELECT through_id, activity, activity_through
      FROM ${sessionEventArchives}
      WHERE session_id = ${sessionId}
      ORDER BY from_id DESC LIMIT 1`),
  );
  return row;
}

/**
 * The next chunk's rows, read under the session row lock every events
 * writer takes; none once the session has moved on since it was listed.
 */
async function nextChunk(
  db: Database,
  sessionId: string,
  after: number,
  cap: number,
): Promise<{ id: number; line: string }[]> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT 1 FROM ${sessions} WHERE id = ${sessionId} FOR UPDATE`,
    );
    return rowsOf<{ id: string; line: string }>(
      await tx.execute(sql`
        SELECT e.id, ${LINE} AS line FROM ${events} e
        WHERE e.session_id = ${sessionId} AND e.id > ${after} AND e.id <= ${cap}
          AND ${settled(sql`${sessionId}::uuid`, cap)}
        ORDER BY e.id LIMIT ${ARCHIVE_CHUNK_EVENTS}`),
    );
  });
  const chunk: { id: number; line: string }[] = [];
  let bytes = 0;
  for (const row of rows) {
    bytes += Buffer.byteLength(row.line, "utf8") + 1;
    if (chunk.length > 0 && bytes > ARCHIVE_CHUNK_BYTES) break;
    chunk.push({ id: Number(row.id), line: row.line });
  }
  return chunk;
}

/**
 * Records the chunk and deletes its rows in one transaction. Refuses, so
 * nothing is deleted, when another pass recorded a chunk of the session
 * since this one read `after`, or when the rows deleted are not exactly the
 * rows archived. False, with nothing changed, once the session is no longer
 * settled.
 */
async function commitChunk(
  db: Database,
  input: {
    sessionId: string;
    after: number;
    chunk: ArchiveChunkRow;
    bytes: number;
    activity: SessionActivity;
    activityThrough: number;
    cap: number;
  },
): Promise<boolean> {
  const { sessionId, chunk } = input;
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT 1 FROM ${sessions} WHERE id = ${sessionId} FOR UPDATE`,
    );
    const [last] = rowsOf<{ through: string | null }>(
      await tx.execute(sql`
        SELECT max(through_id) AS through FROM ${sessionEventArchives}
        WHERE session_id = ${sessionId}`),
    );
    if (Number(last?.through ?? 0) !== input.after) {
      throw new Error(
        `Session ${sessionId} gained an archived chunk while this one was written`,
      );
    }
    const [still] = rowsOf<{ ok: boolean }>(
      await tx.execute(
        sql`SELECT ${settled(sql`${sessionId}::uuid`, input.cap)} AS ok`,
      ),
    );
    if (still?.ok !== true) return false;
    const recorded = rowsOf<{ from_id: string }>(
      await tx.execute(sql`
        INSERT INTO ${sessionEventArchives} (session_id, from_id, through_id,
          object_key, version_id, sha256, event_count, bytes, last_created_at,
          last_occurred_at, activity, activity_through)
        SELECT ${sessionId}, ${chunk.fromId}, ${chunk.throughId},
          ${chunk.objectKey}, ${chunk.versionId}, ${chunk.sha256},
          ${chunk.eventCount}, ${input.bytes}, e.created_at,
          coalesce(e.occurred_at, e.created_at),
          ${JSON.stringify(input.activity)}::jsonb, ${input.activityThrough}
        FROM ${events} e
        WHERE e.session_id = ${sessionId} AND e.id = ${chunk.throughId}
        RETURNING from_id`),
    );
    if (recorded.length !== 1) {
      throw new Error(
        `Session ${sessionId} no longer holds event ${chunk.throughId}`,
      );
    }
    const deleted = rowsOf<{ id: string }>(
      await tx.execute(sql`
        DELETE FROM ${events}
        WHERE session_id = ${sessionId}
          AND id >= ${chunk.fromId} AND id <= ${chunk.throughId}
        RETURNING id`),
    );
    if (deleted.length !== chunk.eventCount) {
      throw new Error(
        `Session ${sessionId} held ${deleted.length} events in ${chunk.fromId}..${chunk.throughId}, ${chunk.eventCount} archived`,
      );
    }
    return true;
  });
}

export type SessionArchiveResult =
  | { status: "planned"; events: number; bytes: number }
  | { status: "archived"; chunks: number; events: number; bytes: number }
  | { status: "failed"; error: unknown };

/** One session's events after `after` through `cap`, chunk by chunk. */
async function archiveSession(
  db: Database,
  store: ArchiveObjectStore,
  sessionId: string,
  cap: number,
): Promise<SessionArchiveResult> {
  const head = await lastChunk(db, sessionId);
  let after = Number(head?.through_id ?? 0);
  // Taken before any row of the pass leaves: the window then still holds
  // every event the pass archives. Rows a cut-short earlier pass left are
  // already inside the stored activity, up to its activity_through.
  const fromActivity = Number(head?.activity_through ?? 0);
  const [top] = rowsOf<{ id: string | null }>(
    await db.execute(sql`
      SELECT max(id) AS id FROM ${events}
      WHERE session_id = ${sessionId} AND id <= ${cap}`),
  );
  const activityThrough = Math.max(Number(top?.id ?? 0), fromActivity);
  const fresh = await readActivityRange(db, sessionId, {
    after: fromActivity,
    through: activityThrough,
  });
  const activity =
    head === undefined ? fresh : mergeActivity(head.activity, fresh);
  let chunks = 0;
  let archived = 0;
  let stored = 0;
  for (;;) {
    const rows = await nextChunk(db, sessionId, after, cap);
    const first = rows[0];
    const last = rows.at(-1);
    if (first === undefined || last === undefined) break;
    const body = encodeArchiveChunk(rows.map(({ line }) => line));
    const key = archiveObjectKey(sessionId, first.id, last.id);
    const put = await store.putImmutable(key, body);
    if (put.outcome !== "created" || put.version === undefined) {
      throw new Error(
        `Archive object ${key} was not created as a new version (${put.outcome})`,
      );
    }
    const chunk: ArchiveChunkRow = {
      fromId: first.id,
      throughId: last.id,
      objectKey: key,
      versionId: put.version,
      sha256: sha256(body),
      eventCount: rows.length,
    };
    await store.hold(key, put.version);
    const back = await readArchiveChunk(store, chunk);
    if (back.some(({ line }, index) => line !== rows[index]?.line)) {
      throw new Error(`Archive object ${key} does not read back as written`);
    }
    const committed = await commitChunk(db, {
      sessionId,
      after,
      chunk,
      bytes: body.byteLength,
      activity,
      activityThrough,
      cap,
    });
    // The held object stays behind unrecorded; nothing reads it.
    if (!committed) break;
    after = last.id;
    chunks += 1;
    archived += rows.length;
    stored += body.byteLength;
  }
  return { status: "archived", chunks, events: archived, bytes: stored };
}

async function planSession(
  db: Database,
  sessionId: string,
  after: number,
  cap: number,
): Promise<SessionArchiveResult> {
  const [row] = rowsOf<{ events: string; bytes: string }>(
    await db.execute(sql`
      SELECT count(*) AS events, coalesce(sum(octet_length(${LINE}) + 1), 0) AS bytes
      FROM ${events} e
      WHERE e.session_id = ${sessionId} AND e.id > ${after} AND e.id <= ${cap}`),
  );
  return {
    status: "planned",
    events: Number(row?.events ?? 0),
    bytes: Number(row?.bytes ?? 0),
  };
}

export type SessionArchiveTotals = {
  sessions: number;
  events: number;
  // Uncompressed on a dry run, as stored otherwise.
  bytes: number;
  chunks: number;
  failed: number;
};

/**
 * One archiving pass over every session older than `afterDays`. A dry run
 * reads what would move and changes nothing. A session that fails keeps
 * every row not yet recorded and the pass goes on to the next.
 */
export async function archiveSessionEvents(
  db: Database,
  store: ArchiveObjectStore,
  options: {
    afterDays: number;
    dryRun: boolean;
    batchSize: number;
    onSession?: (sessionId: string, result: SessionArchiveResult) => void;
  },
): Promise<SessionArchiveTotals> {
  const totals: SessionArchiveTotals = {
    sessions: 0,
    events: 0,
    bytes: 0,
    chunks: 0,
    failed: 0,
  };
  if (options.afterDays <= 0) return totals;
  const cap = await projectedThrough(db);
  let afterId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    const page = await archivableSessions(db, {
      afterDays: options.afterDays,
      cap,
      afterId,
      limit: options.batchSize,
    });
    for (const session of page) {
      let result: SessionArchiveResult;
      try {
        result = options.dryRun
          ? await planSession(db, session.id, session.after, cap)
          : await archiveSession(db, store, session.id, cap);
      } catch (error) {
        result = { status: "failed", error };
      }
      options.onSession?.(session.id, result);
      if (result.status === "failed") {
        totals.failed += 1;
        continue;
      }
      totals.sessions += 1;
      totals.events += result.events;
      totals.bytes += result.bytes;
      if (result.status === "archived") totals.chunks += result.chunks;
    }
    const last = page.at(-1);
    if (last === undefined || page.length < options.batchSize) break;
    afterId = last.id;
  }
  return totals;
}

/**
 * Puts a session's archived events back into `events` under their own ids,
 * newest chunk first so the rows left in `events` always follow the last
 * chunk recorded. The objects stay in the bucket, held.
 */
export async function restoreSessionEvents(
  db: Database,
  source: ArchivedEventSource,
  sessionId: string,
): Promise<{ chunks: number; events: number }> {
  let chunks = 0;
  let restored = 0;
  for (;;) {
    const [row] = rowsOf<ChunkRecord>(
      await db.execute(sql`
        SELECT from_id, through_id, object_key, version_id, sha256, event_count
        FROM ${sessionEventArchives}
        WHERE session_id = ${sessionId}
        ORDER BY from_id DESC LIMIT 1`),
    );
    if (row === undefined) break;
    const chunk = chunkOf(row);
    const lines = await readArchiveChunk(source, chunk);
    await db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT 1 FROM ${sessions} WHERE id = ${sessionId} FOR UPDATE`,
      );
      await tx.execute(sql`
        INSERT INTO ${events} (id, session_id, type, payload, neutral, turn_id,
          attempt_id, source_sequence, occurred_at, created_at)
        SELECT r.id, ${sessionId}, r.type, r.payload, r.neutral, r.turn_id,
          r.attempt_id, r.source_sequence, r.occurred_at, r.created_at
        FROM ${archivedRows(lines.map(({ line }) => line))}`);
      await tx.execute(sql`
        DELETE FROM ${sessionEventArchives}
        WHERE session_id = ${sessionId} AND from_id = ${chunk.fromId}`);
    });
    chunks += 1;
    restored += lines.length;
  }
  return { chunks, events: restored };
}
