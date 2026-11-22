import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database } from "./queries.ts";
import * as schema from "./schema.ts";
import {
  AGENTLESS_CLOSE,
  closeAgentlessSessions,
  NO_AGENT_RELEASE,
} from "./sessions/agentless-close.ts";
import {
  RELEASE_SPEC_SQL_COLUMNS,
  releaseSpecSqlValues,
  SESSION_PIN_SQL_COLUMNS,
  sessionPinSqlValues,
} from "./testing/spec-pins.ts";

/**
 * The start-time pass closes every open session that names no release the
 * way a recovery close does, leaves sessions of a release and closed ones
 * alone, finds nothing the second time, and goes on past one it cannot close.
 */
describe("closeAgentlessSessions", () => {
  let client: PGlite;
  let db: Database;
  const workspaceId = randomUUID();
  let releaseId: string;

  const one = async <T>(sql: string, params: unknown[] = []) =>
    (await client.query<T>(sql, params)).rows[0] as T;
  const session = (id: string) =>
    one<{
      admission_state: string;
      status: string;
      revision: number;
      lease_epoch: number;
    }>(
      "SELECT admission_state, status, revision, lease_epoch FROM sessions WHERE id = $1",
      [id],
    );
  const turnStatuses = async (id: string) =>
    (
      await client.query<{ status: string; terminal_reason: string | null }>(
        "SELECT status, terminal_reason FROM turns WHERE session_id = $1 ORDER BY sequence",
        [id],
      )
    ).rows;
  const receiptOf = (id: string) =>
    one<{ status: string; error: { code: string; message: string } | null }>(
      "SELECT status, error FROM receipts WHERE id = $1",
      [id],
    );
  const count = async (sql: string, params: unknown[]) =>
    Number((await one<{ n: number | string }>(sql, params)).n);
  const closedEvents = async (id: string) =>
    (
      await client.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM events WHERE session_id = $1 AND type = 'system' ORDER BY id",
        [id],
      )
    ).rows.map((row) => row.payload);

  async function addSession(id: string, columns = "", values = "") {
    await client.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, workspace_id${columns})
       VALUES ($1, 'owner', 'https://example.invalid/repo.git', $2, $3${values})`,
      [id, `session/${id}`, workspaceId],
    );
  }

  async function addPinned(id: string) {
    await addSession(
      id,
      `, agent_release_id, ${SESSION_PIN_SQL_COLUMNS}`,
      `, '${releaseId}', ${sessionPinSqlValues()}`,
    );
  }

  /** A completed and a queued turn, the queued one's input receipt, an
   * accepted pause, an open question and a place in the dispatch queue. */
  async function addOpenWork(sessionId: string) {
    const ids = { input: randomUUID(), pause: randomUUID() };
    const turns = await client.query<{ id: number }>(
      `INSERT INTO turns (session_id, sequence, message, status)
       VALUES ($1, 1, 'done', 'completed'), ($1, 2, 'waiting', 'queued') RETURNING id`,
      [sessionId],
    );
    const [ran, queued] = turns.rows;
    await client.query(
      "INSERT INTO queue_messages (session_id, turn_id, kind, payload) VALUES ($1, $2, 'turn', '{}')",
      [sessionId, queued?.id],
    );
    await client.query(
      `INSERT INTO receipts (id, owner_id, operation, target_ref, status)
       VALUES ($1, 'owner', 'append_message', $2, 'accepted'),
              ($3, 'owner', 'pause', $4, 'accepted')`,
      [
        ids.input,
        JSON.stringify({ session_id: sessionId, turn_id: "2" }),
        ids.pause,
        JSON.stringify({ session_id: sessionId }),
      ],
    );
    await client.query(
      `INSERT INTO pending_requests (request_id, session_id, turn_id, attempt_id, kind, payload, input_hash, expires_at)
       VALUES ($1, $2, $3, 'attempt', 'question', '{}', 'hash', now() + interval '1 day')`,
      [`request-${sessionId}`, sessionId, ran?.id],
    );
    await client.query(
      "INSERT INTO unassigned_sessions (session_id) VALUES ($1)",
      [sessionId],
    );
    return ids;
  }

  async function bind(sessionId: string): Promise<string> {
    const executionId = `exec-${randomUUID()}`;
    await client.query(
      "INSERT INTO executions (id, session_id, backend, generation, desired_state, observed_state) VALUES ($1, $2, 'docker', 1, 'running', 'running')",
      [executionId, sessionId],
    );
    await client.query("UPDATE sessions SET execution_id = $1 WHERE id = $2", [
      executionId,
      sessionId,
    ]);
    return executionId;
  }

  beforeEach(async () => {
    client = await migratedPGlite();
    db = drizzle(client, { schema }) as unknown as Database;
    await client.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, 'acme', 'acme')",
      [workspaceId],
    );
    const agentId = randomUUID();
    const versionId = randomUUID();
    releaseId = `sha256:${randomUUID()}`;
    await client.query(
      `WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, 'team') RETURNING id)
       INSERT INTO agents (id, workspace_id, slug, name, managing_team_id) VALUES ($1, $2, 'a', 'a', (SELECT id FROM t))`,
      [agentId, workspaceId],
    );
    await client.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    await client.query(
      `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
         runtime_config_snapshot, effective_tools, ${RELEASE_SPEC_SQL_COLUMNS})
       VALUES ($1, $2, $3, $4, '{}', '{}', ${releaseSpecSqlValues()})`,
      [releaseId, agentId, versionId, "a".repeat(64)],
    );
    // The first migrated PGlite of a run applies every migration.
  }, 60_000);

  afterEach(async () => {
    await client.close();
  });

  test("a session without a release is closed as a recovery close leaves it", async () => {
    const agentless = randomUUID();
    await addSession(agentless, ", status", ", 'running'");
    const executionId = await bind(agentless);
    const receipts = await addOpenWork(agentless);

    const run = await closeAgentlessSessions(db);

    expect(run).toEqual({ closed: [agentless], failed: [] });
    expect(await session(agentless)).toEqual({
      admission_state: "closed",
      status: "stopped",
      revision: 1,
      lease_epoch: 1,
    });
    expect(await turnStatuses(agentless)).toEqual([
      { status: "completed", terminal_reason: null },
      { status: "cancelled", terminal_reason: "closed" },
    ]);
    expect(
      await count(
        "SELECT count(*) AS n FROM queue_messages WHERE session_id = $1",
        [agentless],
      ),
    ).toBe(0);
    expect(await receiptOf(receipts.input)).toMatchObject({
      status: "failed",
      error: { code: "SESSION_CLOSED" },
    });
    expect(await receiptOf(receipts.pause)).toEqual({
      status: "failed",
      error: {
        code: "CONTROL_SUPERSEDED",
        message: "superseded by closing a session without an agent release",
      },
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM pending_requests WHERE session_id = $1 AND resolved_at IS NULL",
        [agentless],
      ),
    ).toBe(0);
    expect(
      await count(
        "SELECT count(*) AS n FROM unassigned_sessions WHERE session_id = $1",
        [agentless],
      ),
    ).toBe(0);
    expect(
      await one<{ desired_state: string }>(
        "SELECT desired_state FROM executions WHERE id = $1",
        [executionId],
      ),
    ).toEqual({ desired_state: "terminated" });
    expect(await closedEvents(agentless)).toEqual([
      {
        type: "system",
        subtype: "session_closed",
        closed_by: AGENTLESS_CLOSE,
        reason: NO_AGENT_RELEASE,
        checkpoint_revision: null,
        cancelled_turn_count: 1,
      },
    ]);
  });

  test("sessions of a release and closed sessions stay as they were, and a second run finds nothing", async () => {
    const agentless = randomUUID();
    const pinned = randomUUID();
    const closed = randomUUID();
    await addSession(agentless);
    await addPinned(pinned);
    const pinnedReceipts = await addOpenWork(pinned);
    await addSession(
      closed,
      ", status, admission_state",
      ", 'stopped', 'closed'",
    );

    expect(await closeAgentlessSessions(db)).toEqual({
      closed: [agentless],
      failed: [],
    });
    const afterFirst = {
      agentless: await session(agentless),
      events: await count("SELECT count(*) AS n FROM events", []),
    };
    expect(await closeAgentlessSessions(db)).toEqual({
      closed: [],
      failed: [],
    });
    expect(await session(agentless)).toEqual(afterFirst.agentless);
    expect(await count("SELECT count(*) AS n FROM events", [])).toBe(
      afterFirst.events,
    );

    expect(await session(pinned)).toEqual({
      admission_state: "active",
      status: "queued",
      revision: 0,
      lease_epoch: 0,
    });
    expect((await turnStatuses(pinned)).map((t) => t.status)).toEqual([
      "completed",
      "queued",
    ]);
    expect(await receiptOf(pinnedReceipts.input)).toEqual({
      status: "accepted",
      error: null,
    });
    expect(await receiptOf(pinnedReceipts.pause)).toEqual({
      status: "accepted",
      error: null,
    });
    expect(
      await count(
        "SELECT count(*) AS n FROM unassigned_sessions WHERE session_id = $1",
        [pinned],
      ),
    ).toBe(1);
    expect(await session(closed)).toEqual({
      admission_state: "closed",
      status: "stopped",
      revision: 0,
      lease_epoch: 0,
    });
    expect(await closedEvents(pinned)).toEqual([]);
    expect(await closedEvents(closed)).toEqual([]);
  });

  test("a session it cannot close is reported and the others still close", async () => {
    const broken = randomUUID();
    const fine = randomUUID();
    await addSession(broken, ", execution_id", ", 'exec-gone'");
    await addSession(fine);

    const run = await closeAgentlessSessions(db);

    expect(run.closed).toEqual([fine]);
    expect(run.failed.map((failure) => failure.sessionId)).toEqual([broken]);
    expect(await session(broken)).toMatchObject({ admission_state: "active" });
    expect(await session(fine)).toMatchObject({ admission_state: "closed" });
  });
});
