import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import type { ReceiptActor } from "@werft-ai/contracts";
import type {
  RepositoryAttachmentOutcome,
  RepositoryAttachmentRequest,
} from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createPostgresGitHubGateStore } from "./github/github-settings.ts";
import * as schema from "./schema.ts";
import {
  createPostgresRepositoryAttachments,
  createPostgresRepositoryPins,
} from "./sessions/repository-attachments.ts";
import {
  releaseSpecColumns,
  SESSION_PIN_SQL_COLUMNS,
  sessionPinSqlValues,
  TEST_CONNECTION_ID,
} from "./testing/spec-pins.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;

const COMMIT = "a".repeat(40);

integration("repository attachments on PostgreSQL", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "repo_attach_it" });
    pool = new Pool({ connectionString: database.url, max: 4 });
    db = drizzle(pool, { schema });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
  }, 60_000);

  const actor: ReceiptActor = {
    principal: { kind: "user", id: "user-1" },
    actor_user_id: "user-1",
    agent_id: null,
  };

  /** A session with an open attempt; `attached` is its starting list. */
  async function session(attached: string[] | null) {
    const ownerId = randomUUID();
    const sessionId = randomUUID();
    const attemptId = `att_${randomUUID()}`;
    await pool.query(
      "INSERT INTO workspaces (id, slug, name) VALUES ($1, $2, 'ws')",
      [ownerId, `ws-${ownerId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO sessions (id, owner_id, repo_url, branch, repository_id,
         workspace_id, attached_repository_ids, ${SESSION_PIN_SQL_COLUMNS})
       VALUES ($1, $2, 'https://github.com/acme/app.git', 'main', 'sample-app',
         $3, $4, ${sessionPinSqlValues()})`,
      [sessionId, ownerId, ownerId, attached],
    );
    await pool.query(
      `INSERT INTO attempts (id, session_id, execution_id, lease_epoch,
         execution_generation, auth_revision, state, lease_expires_at)
       VALUES ($1, $2, 'exec-1', 1, 1, 1, 'running', now() + interval '1 minute')`,
      [attemptId, sessionId],
    );
    const request = (repositoryId = "docs"): RepositoryAttachmentRequest => ({
      ownerId,
      sessionId,
      attemptId,
      repositoryId,
      branch: "main",
      actor,
      result: { repository_id: repositoryId, attempt_id: attemptId },
    });
    const fence = await owning(sessionId, attemptId);
    return { ownerId, sessionId, attemptId, request, fence };
  }

  /** The fence of the session's open attempt, its epochs matched on the session. */
  async function owning(sessionId: string, attemptId: string) {
    await pool.query(
      `UPDATE sessions SET lease_epoch = 1, execution_generation = 1,
         auth_revision = 1 WHERE id = $1`,
      [sessionId],
    );
    return {
      sessionId,
      attemptId,
      leaseEpoch: 1,
      executionGeneration: 1,
      authRevision: 1,
    };
  }

  const receiptOf = (outcome: RepositoryAttachmentOutcome) =>
    outcome.outcome === "requested" ? outcome.row.receiptId : "none";

  async function attachedList(sessionId: string) {
    const { rows } = await pool.query(
      "SELECT attached_repository_ids AS ids FROM sessions WHERE id = $1",
      [sessionId],
    );
    return rows[0]?.ids as string[] | null;
  }

  async function receipts(ownerId: string) {
    const { rows } = await pool.query(
      `SELECT id, status, result, error FROM receipts
        WHERE owner_id = $1 AND operation = 'attach_repository'
        ORDER BY created_at`,
      [ownerId],
    );
    return rows as Array<{
      id: string;
      status: string;
      result: Record<string, unknown>;
      error: { code: string; message: string } | null;
    }>;
  }

  test("a request writes the row, the accepted receipt and the attached list, which the gate reads at once", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const gate = createPostgresGitHubGateStore(db);
    const s = await session([]);
    expect((await gate.context(s.sessionId))?.attachedRepositoryIds).toEqual(
      [],
    );

    const outcome = await store.request(s.request());

    expect(outcome).toMatchObject({
      outcome: "requested",
      row: { repositoryId: "docs", status: "pending", attemptId: s.attemptId },
    });
    expect(await attachedList(s.sessionId)).toEqual(["docs"]);
    expect((await gate.context(s.sessionId))?.attachedRepositoryIds).toEqual([
      "docs",
    ]);
    const [receipt] = await receipts(s.ownerId);
    expect(receipt?.status).toBe("accepted");
    expect(
      (await store.pending(s.sessionId)).map((row) => row.repositoryId),
    ).toEqual(["docs"]);
    expect(
      (await store.list(s.sessionId.toUpperCase())).map((row) => [
        row.repositoryId,
        row.status,
      ]),
    ).toEqual([["docs", "pending"]]);
  });

  test("asking again, or twice at once, leaves one row and one receipt", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const s = await session([]);
    const [a, b] = await Promise.all([
      store.request(s.request()),
      store.request(s.request()),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["requested", "unchanged"]);
    const again = await store.request(s.request());
    expect(again.outcome).toBe("unchanged");
    expect(await receipts(s.ownerId)).toHaveLength(1);
    expect(await attachedList(s.sessionId)).toEqual(["docs"]);
  });

  test("a report settles the row and its receipt once; a resent one changes nothing", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const s = await session([]);
    const receipt_id = receiptOf(await store.request(s.request()));
    const report = {
      repository_id: "docs",
      receipt_id,
      status: "attached" as const,
      commit: COMMIT,
    };
    await store.settle(s.fence, [report]);
    await store.settle(s.fence, [
      {
        repository_id: "docs",
        receipt_id,
        status: "failed",
        failure: "fetch_failed",
      },
    ]);

    expect(await store.find(s.sessionId, "docs")).toMatchObject({
      status: "attached",
      commit: COMMIT,
      failure: null,
    });
    const [receipt] = await receipts(s.ownerId);
    expect(receipt).toMatchObject({
      status: "succeeded",
      error: null,
      result: { repository_id: "docs", commit: COMMIT },
    });
    expect(await store.pending(s.sessionId)).toEqual([]);
    expect(await store.request(s.request())).toMatchObject({
      outcome: "unchanged",
      row: { status: "attached", commit: COMMIT },
    });
    expect(await receipts(s.ownerId)).toHaveLength(1);
  });

  test("an attached report pins its commit, first writer wins, and the pin outlives a failed re-attach", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const pins = createPostgresRepositoryPins(db);
    const s = await session([]);
    const OTHER = "b".repeat(40);
    expect(await pins.list(s.sessionId)).toEqual(new Map());

    await store.settle(s.fence, [
      {
        repository_id: "docs",
        receipt_id: receiptOf(await store.request(s.request())),
        status: "attached",
        commit: COMMIT,
      },
    ]);
    expect(await pins.list(s.sessionId)).toEqual(new Map([["docs", COMMIT]]));

    // A worker that fetched another tip is answered with the kept pin.
    const { fence } = s;
    expect(
      await pins.pin({ ...fence, sessionId: s.sessionId.toUpperCase() }, [
        { repositoryId: "docs", commit: OTHER },
        { repositoryId: "tools", commit: OTHER },
      ]),
    ).toEqual({
      outcome: "ok",
      pins: new Map([
        ["docs", COMMIT],
        ["tools", OTHER],
      ]),
    });
    expect(await pins.pin(fence, [])).toEqual({
      outcome: "ok",
      pins: new Map(),
    });
    // Another session's pins are its own.
    const t = await session([]);
    expect(await pins.list(t.sessionId)).toEqual(new Map());
    await expect(
      pins.pin(t.fence, [{ repositoryId: "docs", commit: "c0ffee" }]),
    ).rejects.toThrow();
  });

  test("only the attempt that owns the session pins", async () => {
    const pins = createPostgresRepositoryPins(db);
    const s = await session([]);
    const { fence } = s;
    const asked = [{ repositoryId: "docs", commit: COMMIT }];

    expect(await pins.pin({ ...fence, leaseEpoch: 0 }, asked)).toEqual({
      outcome: "stale_epoch",
    });
    await pool.query(
      "UPDATE attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [s.attemptId],
    );
    expect(await pins.pin(fence, asked)).toEqual({ outcome: "lease_expired" });
    expect(await pins.list(s.sessionId)).toEqual(new Map());
  });

  async function restoreEvents(sessionId: string) {
    const { rows } = await pool.query(
      `SELECT payload FROM events
        WHERE session_id = $1 AND type = 'system'
          AND payload->>'subtype' = 'repository_restore_failed'`,
      [sessionId],
    );
    return rows.map((row) => row.payload as Record<string, unknown>);
  }

  test("a restore failure marks only the pin it names, once, with one session event", async () => {
    const pins = createPostgresRepositoryPins(db);
    const s = await session(["docs"]);
    const OTHER = "b".repeat(40);
    const failed = (commit: string) => [{ repositoryId: "docs", commit }];
    await pins.pin(s.fence, [{ repositoryId: "docs", commit: COMMIT }]);

    // Not the owner: nothing marked.
    expect(
      await pins.pin({ ...s.fence, leaseEpoch: 0 }, [], failed(COMMIT)),
    ).toEqual({ outcome: "stale_epoch" });
    // Another commit than the pin: an old report, not this pin's failure.
    await pins.pin(s.fence, [], failed(OTHER));
    expect(await pins.restoreFailures(s.sessionId)).toEqual(new Map());
    expect(await restoreEvents(s.sessionId)).toEqual([]);

    await pins.pin(s.fence, [], failed(COMMIT));
    await pins.pin(s.fence, [], failed(COMMIT));
    expect(await pins.restoreFailures(s.sessionId.toUpperCase())).toEqual(
      new Map([["docs", COMMIT]]),
    );
    expect(await pins.list(s.sessionId)).toEqual(new Map());
    expect(await restoreEvents(s.sessionId)).toEqual([
      {
        type: "system",
        subtype: "repository_restore_failed",
        repository_id: "docs",
        commit: COMMIT,
      },
    ]);
    // A worker that fetched the tip meanwhile is not answered with it: the
    // repository stays failed until it is asked for again.
    expect(
      await pins.pin(s.fence, [{ repositoryId: "docs", commit: OTHER }]),
    ).toEqual({ outcome: "ok", pins: new Map() });
    expect(await pins.restoreFailures(s.sessionId)).toEqual(
      new Map([["docs", COMMIT]]),
    );
  });

  test("asking again for a repository whose pin failed fetches it anew and pins what that fetch took", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const pins = createPostgresRepositoryPins(db);
    const OTHER = "b".repeat(40);
    // On the list from the start, and attached mid-session: neither answers
    // "already attached" once its pin is lost.
    const started = await session(["docs"]);
    const attached = await session([]);
    await store.settle(attached.fence, [
      {
        repository_id: "docs",
        receipt_id: receiptOf(await store.request(attached.request())),
        status: "attached",
        commit: COMMIT,
      },
    ]);
    await pins.pin(started.fence, [{ repositoryId: "docs", commit: COMMIT }]);
    for (const s of [started, attached]) {
      await pins.pin(s.fence, [], [{ repositoryId: "docs", commit: COMMIT }]);

      const outcome = await store.request(s.request());
      expect(outcome).toMatchObject({
        outcome: "requested",
        row: { status: "pending", commit: null },
      });
      expect(await pins.restoreFailures(s.sessionId)).toEqual(new Map());
      expect(await attachedList(s.sessionId)).toEqual(["docs"]);
      await store.settle(s.fence, [
        {
          repository_id: "docs",
          receipt_id: receiptOf(outcome),
          status: "attached",
          commit: OTHER,
        },
      ]);
      expect(await pins.list(s.sessionId)).toEqual(new Map([["docs", OTHER]]));
    }
    expect(
      (await receipts(attached.ownerId)).map((receipt) => receipt.status),
    ).toEqual(["succeeded", "succeeded"]);
  });

  test("a fetch pending when its pin is lost keeps its receipt and pins what it took", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const pins = createPostgresRepositoryPins(db);
    const OTHER = "b".repeat(40);
    const lose = async (s: Awaited<ReturnType<typeof session>>) => {
      await pins.pin(s.fence, [{ repositoryId: "docs", commit: COMMIT }]);
      await pins.pin(s.fence, [], [{ repositoryId: "docs", commit: COMMIT }]);
    };
    const settled = (s: Awaited<ReturnType<typeof session>>, id: string) =>
      store.settle(s.fence, [
        {
          repository_id: "docs",
          receipt_id: id,
          status: "attached",
          commit: OTHER,
        },
      ]);

    // Asked again meanwhile: the pending fetch stays the one to settle.
    const asked = await session([]);
    const first = receiptOf(await store.request(asked.request()));
    await lose(asked);
    expect(await store.request(asked.request())).toMatchObject({
      outcome: "unchanged",
      row: { status: "pending", receiptId: first },
    });
    expect(await pins.restoreFailures(asked.sessionId)).toEqual(new Map());
    await settled(asked, first);
    expect(await pins.list(asked.sessionId)).toEqual(
      new Map([["docs", OTHER]]),
    );
    expect(await receipts(asked.ownerId)).toHaveLength(1);

    // Not asked again: what the fetch took replaces the lost pin.
    const quiet = await session([]);
    const only = receiptOf(await store.request(quiet.request()));
    await lose(quiet);
    await settled(quiet, only);
    expect(await pins.list(quiet.sessionId)).toEqual(
      new Map([["docs", OTHER]]),
    );
    expect(await pins.restoreFailures(quiet.sessionId)).toEqual(new Map());
  });

  test("a report from an attempt that lost the session settles and pins nothing", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const pins = createPostgresRepositoryPins(db);
    const s = await session([]);
    const receipt_id = receiptOf(await store.request(s.request()));
    const report = {
      repository_id: "docs",
      receipt_id,
      status: "attached" as const,
      commit: COMMIT,
    };

    expect(await store.settle({ ...s.fence, leaseEpoch: 0 }, [report])).toEqual(
      { outcome: "stale_epoch" },
    );
    await pool.query(
      "UPDATE attempts SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [s.attemptId],
    );
    expect(await store.settle(s.fence, [report])).toEqual({
      outcome: "lease_expired",
    });

    expect(await store.find(s.sessionId, "docs")).toMatchObject({
      status: "pending",
      receiptId: receipt_id,
    });
    expect(await pins.list(s.sessionId)).toEqual(new Map());
    expect((await receipts(s.ownerId)).map((r) => r.status)).toEqual([
      "accepted",
    ]);
  });

  test("a settle and a pin of the same repository at once both finish", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const pins = createPostgresRepositoryPins(db);
    for (let round = 0; round < 10; round += 1) {
      const s = await session([]);
      const receipt_id = receiptOf(await store.request(s.request()));
      const [settled, pinned] = await Promise.all([
        store.settle(s.fence, [
          {
            repository_id: "docs",
            receipt_id,
            status: "attached",
            commit: COMMIT,
          },
        ]),
        pins.pin(s.fence, [{ repositoryId: "docs", commit: "b".repeat(40) }]),
      ]);
      expect(settled).toEqual({ outcome: "ok" });
      expect(pinned.outcome).toBe("ok");
      const kept = await pins.list(s.sessionId);
      expect(pinned).toEqual({ outcome: "ok", pins: kept });
    }
  }, 30_000);

  test("a failed fetch leaves the list and fails its receipt; asking again starts over with a new receipt", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const s = await session(["other"]);
    const failedReport = {
      repository_id: "docs",
      receipt_id: receiptOf(await store.request(s.request())),
      status: "failed" as const,
      failure: "fetch_too_large" as const,
    };
    await store.settle(s.fence, [failedReport]);

    expect(await attachedList(s.sessionId)).toEqual(["other"]);
    const [failed] = await receipts(s.ownerId);
    expect(failed).toMatchObject({
      status: "failed",
      result: { failure: "fetch_too_large" },
      error: { code: "BACKEND_UNAVAILABLE" },
    });

    const retried = await store.request(s.request());
    expect(retried).toMatchObject({
      outcome: "requested",
      row: { status: "pending", failure: null },
    });
    expect(await attachedList(s.sessionId)).toEqual(["other", "docs"]);
    const all = await receipts(s.ownerId);
    expect(all).toHaveLength(2);
    expect(receiptOf(retried)).toBe(all[1]?.id ?? "missing");

    // The first failure, resent after the retry, settles nothing of it.
    await store.settle(s.fence, [failedReport]);
    expect(await store.find(s.sessionId, "docs")).toMatchObject({
      status: "pending",
      receiptId: receiptOf(retried),
    });
    expect(await attachedList(s.sessionId)).toEqual(["other", "docs"]);
    expect((await receipts(s.ownerId)).map((r) => r.status)).toEqual([
      "failed",
      "accepted",
    ]);
  });

  test("an ended attempt is refused and writes nothing", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const s = await session([]);
    await pool.query("UPDATE attempts SET ended_at = now() WHERE id = $1", [
      s.attemptId,
    ]);
    expect(await store.request(s.request())).toEqual({
      outcome: "attempt_ended",
    });
    expect(
      await store.request({ ...s.request(), attemptId: "att_other" }),
    ).toEqual({ outcome: "attempt_ended" });
    expect(await store.find(s.sessionId, "docs")).toBeNull();
    expect(await receipts(s.ownerId)).toEqual([]);
    expect(await attachedList(s.sessionId)).toEqual([]);
  });

  test("one on the list from the start, or on a null list, is preattached: no row, no receipt", async () => {
    const store = createPostgresRepositoryAttachments(db);
    for (const attached of [["docs"], null]) {
      const s = await session(attached);
      expect(await store.request(s.request())).toEqual({
        outcome: "preattached",
      });
      expect(await store.find(s.sessionId, "docs")).toBeNull();
      expect(await receipts(s.ownerId)).toEqual([]);
      expect(await attachedList(s.sessionId)).toEqual(attached);
    }
  });

  test("a refusal is a failed receipt with the error given", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const s = await session([]);
    const id = await store.recordRefusal({
      ownerId: s.ownerId,
      sessionId: s.sessionId,
      actor,
      result: {
        repository_id: "secret",
        reason_code: "repository_not_allowed",
      },
      error: {
        code: "GITHUB_REFUSED",
        message: "GitHub work refused: repository_not_allowed",
      },
    });
    expect(await receipts(s.ownerId)).toEqual([
      {
        id,
        status: "failed",
        result: {
          repository_id: "secret",
          reason_code: "repository_not_allowed",
        },
        error: {
          code: "GITHUB_REFUSED",
          message: "GitHub work refused: repository_not_allowed",
        },
      },
    ]);
  });

  test("activeRelease reads the agent's active release, not the one the session keeps", async () => {
    const store = createPostgresRepositoryAttachments(db);
    const s = await session([]);
    const agentId = randomUUID();
    const versionId = randomUUID();
    const github = (repositories: string[]) => ({
      repositories,
      features: {
        workflows: false,
        actions: false,
        checks: false,
        issues: false,
        review: false,
      },
      actions_allow: [],
      push_approval: true,
    });
    await pool.query(
      "WITH t AS (INSERT INTO member_teams (id, workspace_id, name) VALUES (gen_random_uuid(), $2, gen_random_uuid()::text) RETURNING id) INSERT INTO agents (id, workspace_id, slug, name, github_enabled, managing_team_id) VALUES ($1, $2, $3, 'a', true, (SELECT id FROM t))",
      [agentId, s.ownerId, `a-${agentId.slice(0, 8)}`],
    );
    await pool.query(
      `INSERT INTO agent_versions (id, agent_id, version_no, card, content_sha256)
       VALUES ($1, $2, 1, '{}', $3)`,
      [versionId, agentId, "a".repeat(64)],
    );
    const release = async (pins: object) => {
      const id = `sha256:${randomUUID()}`;
      const spec = releaseSpecColumns();
      await pool.query(
        `INSERT INTO agent_releases (id, agent_id, version_id, card_sha256,
           connection_id, repository_id, runtime_config_snapshot,
           effective_tools, policy_pins, spec_source, spec_source_digest,
           runtime_spec, spec_digest)
         VALUES ($1, $2, $3, $4, $5, 'sample-app', '{}', '{}', $6, $7, $8, $9, $10)`,
        [
          id,
          agentId,
          versionId,
          "a".repeat(64),
          TEST_CONNECTION_ID,
          JSON.stringify(pins),
          JSON.stringify(spec.specSource),
          spec.specSourceDigest,
          JSON.stringify(spec.runtimeSpec),
          spec.specDigest,
        ],
      );
      return id;
    };
    const activate = (id: string, revision: number) =>
      pool.query(
        "UPDATE agents SET active_release_id = $2, activation_revision = $3 WHERE id = $1",
        [agentId, id, revision],
      );

    expect(await store.activeRelease(s.sessionId)).toBeNull();

    const pinned = await release({ github: github(["sample-app"]) });
    await activate(pinned, 0);
    await pool.query(
      "UPDATE sessions SET agent_release_id = $2 WHERE id = $1",
      [s.sessionId, pinned],
    );
    expect(await store.activeRelease(s.sessionId)).toEqual({
      id: pinned,
      github: github(["sample-app"]),
    });

    const newer = await release({ github: github(["sample-app", "docs"]) });
    await activate(newer, 1);
    expect(await store.activeRelease(s.sessionId.toUpperCase())).toEqual({
      id: newer,
      github: github(["sample-app", "docs"]),
    });

    const bare = await release({});
    await activate(bare, 2);
    expect(await store.activeRelease(s.sessionId)).toEqual({
      id: bare,
      github: null,
    });

    const broken = await release({ github: { repositories: "docs" } });
    await activate(broken, 3);
    expect(await store.activeRelease(s.sessionId)).toEqual({
      id: broken,
      github: "invalid",
    });
  });
});
