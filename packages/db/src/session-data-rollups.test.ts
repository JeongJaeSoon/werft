import { afterEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "./migrate.ts";
import { MIGRATIONS_FOLDER, readJournal } from "./migration-folder.ts";
import {
  BEFORE_PROFILE_REMOVAL,
  migrationsThrough,
} from "./testing/migrations-through.ts";

/**
 * The counters migration session_data_rollups keeps by trigger, against the
 * full aggregations /metrics and installation usage ran before it: after
 * every kind of write they must say the same.
 */

const clients: PGlite[] = [];
const folders: string[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
  for (const folder of folders.splice(0)) {
    rmSync(folder, { recursive: true, force: true });
  }
});

async function database(): Promise<PGlite> {
  const client = await migratedPGlite();
  clients.push(client);
  return client;
}

const rows = async (client: PGlite, query: string) =>
  (await client.query(query)).rows;

const TOOL_CALLS_FULL = `
  SELECT name, outcome, count(*)::int AS calls FROM tool_calls
  GROUP BY 1, 2 ORDER BY 1, 2`;
const TOOL_CALLS_COUNTED = `
  SELECT name, outcome, calls::int AS calls FROM tool_call_outcomes
  WHERE calls > 0 ORDER BY 1, 2`;
const TOOL_FIRST_FULL = `
  SELECT name, min(created_at) AS first_at FROM tool_calls GROUP BY 1 ORDER BY 1`;
const TOOL_FIRST_COUNTED = `
  SELECT name, min(first_at) AS first_at FROM tool_call_outcomes
  WHERE name IN (SELECT name FROM tool_call_outcomes WHERE calls > 0)
  GROUP BY 1 ORDER BY 1`;

const USAGE_FULL = `
  SELECT model, priced_by, count(*)::int AS calls,
         sum(input_tokens)::float8 AS input, sum(output_tokens)::float8 AS output,
         sum(cache_read_input_tokens)::float8 AS cache_read,
         sum(cache_creation_input_tokens)::float8 AS cache_write,
         sum(cost_usd)::float8 AS cost, min(recorded_at) AS first_at
  FROM provider_usage GROUP BY 1, 2 ORDER BY 1, 2`;
const USAGE_COUNTED = `
  SELECT model, priced_by, calls::int AS calls,
         input_tokens::float8 AS input, output_tokens::float8 AS output,
         cache_read_input_tokens::float8 AS cache_read,
         cache_creation_input_tokens::float8 AS cache_write,
         cost_usd::float8 AS cost, first_at
  FROM provider_usage_totals WHERE calls > 0 ORDER BY 1, 2`;

// The installation usage query before the counters.
const OUTPUTS_FULL = `
  SELECT co.session_id, co.object_key, max(co.bytes)::int AS bytes,
         bool_or(c.objects_purged_at IS NULL) AS kept,
         min(c.committed_at) AS first_at, max(c.objects_purged_at) AS released_at
  FROM checkpoint_outputs co
  JOIN checkpoints c ON c.session_id = co.session_id AND c.revision = co.revision
  GROUP BY 1, 2 ORDER BY 1, 2`;
const OUTPUTS_COUNTED = `
  SELECT session_id, object_key, bytes::int AS bytes, live_refs > 0 AS kept,
         first_at, released_at
  FROM checkpoint_output_objects ORDER BY 1, 2`;
const KEPT_FULL = `
  SELECT coalesce(sum(bytes) FILTER (WHERE kept), 0)::int AS bytes
  FROM (${OUTPUTS_FULL}) AS objects`;
const KEPT_COUNTED = `
  SELECT kept_bytes::int AS bytes FROM checkpoint_output_totals
  WHERE scope = 'installation'`;

async function expectToolCallsCounted(client: PGlite) {
  expect(await rows(client, TOOL_CALLS_COUNTED)).toEqual(
    await rows(client, TOOL_CALLS_FULL),
  );
  expect(await rows(client, TOOL_FIRST_COUNTED)).toEqual(
    await rows(client, TOOL_FIRST_FULL),
  );
}

async function expectUsageCounted(client: PGlite) {
  expect(await rows(client, USAGE_COUNTED)).toEqual(
    await rows(client, USAGE_FULL),
  );
}

async function expectOutputsCounted(client: PGlite) {
  expect(await rows(client, OUTPUTS_COUNTED)).toEqual(
    await rows(client, OUTPUTS_FULL),
  );
  expect(await rows(client, KEPT_COUNTED)).toEqual(
    await rows(client, KEPT_FULL),
  );
}

async function session(client: PGlite): Promise<string> {
  const id = crypto.randomUUID();
  await client.query(
    `INSERT INTO sessions (id, owner_id, repo_url, branch)
     VALUES ($1, 'owner-a', 'https://example.invalid/r.git', $2)`,
    [id, `session/${id}`],
  );
  return id;
}

async function attempt(client: PGlite, sessionId: string): Promise<string> {
  const executionId = `exec-${crypto.randomUUID()}`;
  await client.query(
    `INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state)
     VALUES ($1, $2, 'local_docker', 0, 'running', 'running')`,
    [executionId, sessionId],
  );
  const id = `att-${crypto.randomUUID()}`;
  await client.query(
    `INSERT INTO attempts (id, session_id, execution_id, lease_epoch, execution_generation, auth_revision, state, lease_expires_at)
     VALUES ($1, $2, $3, 0, 0, 0, 'running', now() + interval '1 hour')`,
    [id, sessionId, executionId],
  );
  return id;
}

let useEventId = 0;
// One statement for all the calls, as the projector writes a batch.
async function toolCalls(
  client: PGlite,
  sessionId: string,
  calls: { name: string; outcome: string; createdAt: string }[],
) {
  const values = calls.map((call) => {
    useEventId += 1;
    const at = `'${call.createdAt}'::timestamptz`;
    return `(${useEventId}, 0, '${sessionId}', '', 'tu-${useEventId}', '${call.name}', ${at}, ${at}, '${call.outcome}')`;
  });
  await client.query(
    `INSERT INTO tool_calls (use_event_id, ord, session_id, attempt_key, tool_use_id, name, at, created_at, outcome)
     VALUES ${values.join(", ")}`,
  );
}

let exchange = 0;
async function usage(
  client: PGlite,
  at: { sessionId: string; attemptId: string },
  calls: { model: string; pricedBy: string; tokens: number; cost: number }[],
) {
  const values = calls.map((call) => {
    exchange += 1;
    return `('ex-${exchange}', '${at.sessionId}', '${at.attemptId}', '${call.model}', ${call.tokens}, ${call.tokens * 2}, ${call.tokens * 3}, 0, ${call.tokens * 4}, false, ${call.cost}, '${call.pricedBy}', now() - ${exchange} * interval '1 minute')`;
  });
  await client.query(
    `INSERT INTO provider_usage (exchange_id, session_id, attempt_id, model, input_tokens, output_tokens, cache_creation_input_tokens, cache_creation_1h_input_tokens, cache_read_input_tokens, estimated, cost_usd, priced_by, recorded_at)
     VALUES ${values.join(", ")}`,
  );
}

async function checkpoint(
  client: PGlite,
  sessionId: string,
  revision: number,
  outputs: Record<string, number>,
) {
  await client.query(
    `INSERT INTO checkpoints (session_id, revision, manifest_ref, manifest_sha256, committed_at, outputs_recorded)
     VALUES ($1, $2, 'ref', 'sha', now() - (10 - $2) * interval '1 minute', true)`,
    [sessionId, revision],
  );
  const values = Object.entries(outputs).map(
    ([key, bytes]) => `('${sessionId}', ${revision}, '${key}', ${bytes})`,
  );
  if (values.length > 0) {
    await client.query(
      `INSERT INTO checkpoint_outputs (session_id, revision, object_key, bytes) VALUES ${values.join(", ")}`,
    );
  }
}

const purge = (client: PGlite, sessionId: string, through: number) =>
  client.query(
    `UPDATE checkpoints SET collected_at = now(), objects_purged_at = now()
     WHERE session_id = $1 AND revision <= $2 AND objects_purged_at IS NULL`,
    [sessionId, through],
  );

describe("session data rollups", () => {
  test("tool call outcomes follow inserts, outcome changes, deletes and truncate", async () => {
    const client = await database();
    const sessionId = await session(client);
    await toolCalls(client, sessionId, [
      { name: "Bash", outcome: "unknown", createdAt: "2026-10-01T00:00:00Z" },
      { name: "Bash", outcome: "unknown", createdAt: "2026-10-02T00:00:00Z" },
      { name: "Bash", outcome: "ok", createdAt: "2026-10-03T00:00:00Z" },
      { name: "Read", outcome: "failed", createdAt: "2026-10-04T00:00:00Z" },
    ]);
    await expectToolCallsCounted(client);

    // A result arriving, and in one statement two calls trading outcomes.
    await client.query(
      `UPDATE tool_calls SET outcome = 'failed' WHERE created_at = '2026-10-01T00:00:00Z'`,
    );
    await client.query(
      `UPDATE tool_calls SET outcome = CASE outcome WHEN 'ok' THEN 'failed' ELSE 'ok' END
       WHERE name = 'Bash' AND outcome IN ('ok', 'failed')`,
    );
    await client.query(`UPDATE tool_calls SET ms = 5`);
    await expectToolCallsCounted(client);

    await client.query(`DELETE FROM tool_calls WHERE name = 'Read'`);
    await client.query(
      `DELETE FROM tool_calls WHERE created_at = '2026-10-02T00:00:00Z'`,
    );
    await expectToolCallsCounted(client);

    await client.query(`TRUNCATE tool_calls`);
    expect(await rows(client, `SELECT * FROM tool_call_outcomes`)).toEqual([]);
  });

  test("provider usage totals follow inserts, deletes and truncate", async () => {
    const client = await database();
    const sessionId = await session(client);
    const at = { sessionId, attemptId: await attempt(client, sessionId) };
    await usage(client, at, [
      { model: "m-a", pricedBy: "table", tokens: 10, cost: 0.125 },
      { model: "m-a", pricedBy: "table", tokens: 20, cost: 0.25 },
      { model: "m-a", pricedBy: "fallback", tokens: 30, cost: 1 },
    ]);
    await usage(client, at, [
      { model: "m-b", pricedBy: "unmetered", tokens: 5, cost: 0 },
    ]);
    await expectUsageCounted(client);

    await client.query(
      `DELETE FROM provider_usage WHERE input_tokens IN (10, 5)`,
    );
    await expectUsageCounted(client);

    await client.query(`TRUNCATE provider_usage`);
    expect(await rows(client, `SELECT * FROM provider_usage_totals`)).toEqual(
      [],
    );
  });

  test("kept output bytes follow commits, inherited keys, purges and deletes", async () => {
    const client = await database();
    const a = await session(client);
    const b = await session(client);
    await checkpoint(client, a, 1, { "a/k1": 10, "a/k2": 20 });
    // A later revision names its parent's object again.
    await checkpoint(client, a, 2, { "a/k1": 10, "a/k3": 30 });
    await checkpoint(client, b, 1, { "b/k1": 7 });
    await expectOutputsCounted(client);

    // a/k2 goes with revision 1; a/k1 stays, revision 2 still names it.
    await purge(client, a, 1);
    await expectOutputsCounted(client);
    await purge(client, a, 2);
    await expectOutputsCounted(client);
    expect(await rows(client, KEPT_COUNTED)).toEqual([{ bytes: 7 }]);

    // A key named again after its release is kept again.
    await checkpoint(client, a, 3, { "a/k1": 12 });
    await expectOutputsCounted(client);

    // Changes no pass makes today: counted again from the rows.
    await client.query(
      `UPDATE checkpoints SET objects_purged_at = NULL WHERE session_id = $1 AND revision = 2`,
      [a],
    );
    await expectOutputsCounted(client);
    await client.query(
      `DELETE FROM checkpoint_outputs WHERE session_id = $1 AND object_key = 'a/k3'`,
      [a],
    );
    await client.query(`DELETE FROM checkpoint_outputs WHERE session_id = $1`, [
      b,
    ]);
    await expectOutputsCounted(client);

    await client.query(`TRUNCATE checkpoint_outputs`);
    await expectOutputsCounted(client);
    expect(await rows(client, KEPT_COUNTED)).toEqual([{ bytes: 0 }]);
  });

  test("the migration counts the rows written before it", async () => {
    const tag = readJournal(MIGRATIONS_FOLDER).find((entry) =>
      entry.tag.endsWith("_session_data_rollups"),
    )?.tag;
    if (!tag) throw new Error("session_data_rollups is not in the journal");
    const before = mkdtempSync(join(tmpdir(), "rollups-"));
    folders.push(before);
    cpSync(MIGRATIONS_FOLDER, before, { recursive: true });
    const journalPath = join(before, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
      entries: { tag: string }[];
    };
    const at = journal.entries.findIndex((entry) => entry.tag === tag);
    journal.entries = journal.entries.slice(0, at);
    writeFileSync(journalPath, JSON.stringify(journal));

    const client = new PGlite();
    clients.push(client);
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: before });

    const sessionId = await session(client);
    const usageAt = { sessionId, attemptId: await attempt(client, sessionId) };
    await toolCalls(client, sessionId, [
      { name: "Bash", outcome: "ok", createdAt: "2026-10-01T00:00:00Z" },
      { name: "Bash", outcome: "failed", createdAt: "2026-10-02T00:00:00Z" },
    ]);
    await usage(client, usageAt, [
      { model: "m-a", pricedBy: "table", tokens: 10, cost: 0.5 },
    ]);
    await checkpoint(client, sessionId, 1, { k1: 10, k2: 20 });
    await checkpoint(client, sessionId, 2, { k1: 10 });
    await purge(client, sessionId, 1);

    // Up to the profile removal, which empties the session tables.
    const after = migrationsThrough(BEFORE_PROFILE_REMOVAL);
    folders.push(after);
    await migrate(db, { migrationsFolder: after });
    await expectToolCallsCounted(client);
    await expectUsageCounted(client);
    await expectOutputsCounted(client);
    expect(await rows(client, KEPT_COUNTED)).toEqual([{ bytes: 10 }]);
  });

  test("the unsettled turn counts can read the partial status index", async () => {
    const client = await database();
    await client.query(`SET enable_seqscan = off`);
    for (const status of ["queued", "outcome_unknown"]) {
      const plan = await rows(
        client,
        `EXPLAIN SELECT count(*) FROM turns WHERE status = '${status}'`,
      );
      expect(JSON.stringify(plan)).toContain("turns_unsettled_status_idx");
    }
  });
});
