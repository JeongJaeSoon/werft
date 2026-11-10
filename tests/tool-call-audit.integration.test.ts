import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type AppendEventsRequest,
  appendEventsRequestSchema,
  createSessionResponseSchema,
  type ToolDecisionReport,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionControl,
  createPostgresSessionReader,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerPendingStore,
  createPostgresWorkerUnitOfWork,
  unassignedSessions,
} from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import {
  createAuthorizationPolicy,
  createSessionService,
  createWorkerGateway,
  type SessionCatalog,
  type WorkerPrincipal,
} from "@werft-ai/platform";
import { createTempDatabase, type TempDatabase } from "@werft-ai/testkit";
import { and, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { createApiApp } from "../apps/control-host/src/api/app.ts";
import { registerSessionRoutes } from "../apps/control-host/src/api/routes/sessions.ts";
import { testCatalog } from "../apps/control-host/src/testing/catalog.ts";
import {
  allowingPolicy,
  allowRepositories,
  releaseIn,
  sessionReleases,
  startingInWorkspace,
} from "../apps/control-host/src/testing/releases.ts";

const databaseUrl = process.env.QUEUE_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;

const catalog: SessionCatalog = testCatalog({
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
    },
  },
});

const OCCURRED_AT = "2026-01-01T00:00:00.000Z";
const SHA = "a".repeat(64);
const OTHER_SHA = "b".repeat(64);

type Worker = {
  sessionId: string;
  principal: WorkerPrincipal;
  scope: Omit<AppendEventsRequest, "batch_key" | "events" | "tool_decisions">;
  turnRowId: number;
  nextSequence: number;
};

integration("tool call audit end to end", () => {
  let database: TempDatabase;
  let pool: Pool;
  let db: NodePgDatabase<typeof schema>;
  let server: ReturnType<typeof Bun.serve>;
  let workers: ReturnType<typeof createWorkerGateway>;
  let findings: Array<Record<string, unknown>> = [];
  const owner = crypto.randomUUID();
  let releaseId = "";

  beforeAll(async () => {
    database = await createTempDatabase({ prefix: "tool_call_audit_e2e" });
    pool = new Pool({ connectionString: database.url, max: 8 });
    db = drizzle(pool, { schema });
    releaseId = await releaseIn(db, owner);
    await allowRepositories(db, owner, ["sample-app"]);
    const service = (authorization: typeof allowingPolicy) =>
      createSessionService({
        authorization,
        inputs: createPostgresSessionUnitOfWork(db),
        controls: createPostgresSessionControl(db),
        reader: createPostgresSessionReader(db),
        catalog,
        limits: {
          queuedInputLimitPerSession: 1_000,
          storageLimitBytes: 1e15,
          sessionCostLimitUsd: 1_000,
          sessionTokenLimit: null,
        },
        releases: sessionReleases(db, catalog),
      });
    const sessions = startingInWorkspace(
      service(createAuthorizationPolicy()),
      service(allowingPolicy),
    );
    workers = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog,
      checkpoints: { verify: async () => ({ status: "verified" }) },
      pending: createPostgresWorkerPendingStore(db),
      onToolAudit: (finding) => findings.push(finding),
      options: {
        leaseTtlMs: 60_000,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
    });
    const app = createApiApp({
      authMode: "none",
      registerRoutes: (router) => registerSessionRoutes(router, sessions),
    });
    server = Bun.serve({ port: 0, fetch: (request) => app.fetch(request) });
  }, 90_000);

  afterAll(async () => {
    server?.stop(true);
    await pool?.end();
    await database?.drop();
  }, 90_000);

  async function startWorker(): Promise<Worker> {
    const created = await fetch(`http://127.0.0.1:${server.port}/v1/sessions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": crypto.randomUUID(),
        "X-Owner-Id": owner,
      },
      body: JSON.stringify({
        agent_release_id: releaseId,
        repository_id: "sample-app",
        message: "first turn",
      }),
    });
    expect(created.status).toBe(201);
    const { session_id: sessionId } = createSessionResponseSchema.parse(
      await created.json(),
    );
    const partition = `tool-audit-${crypto.randomUUID()}`;
    await db
      .update(schema.sessions)
      .set({ partition })
      .where(eq(schema.sessions.id, sessionId));
    await db
      .update(unassignedSessions)
      .set({ partition })
      .where(eq(unassignedSessions.sessionId, sessionId));
    const launch = await launchSession(db, { sessionId });
    const bootstrap = await workers.authenticate(launch.nonce);
    const claim = await workers.bootstrapClaim(bootstrap, {
      execution_id: launch.executionId,
      execution_generation: launch.generation,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    });
    const principal = await workers.authenticate(claim.session_credential);
    const scope = {
      session_id: claim.session_id,
      turn_id: null,
      attempt_id: claim.attempt_id,
      lease_epoch: claim.lease_epoch,
      execution_generation: claim.execution_generation,
      auth_revision: claim.auth_revision,
    };
    const input = await workers.nextInput(principal, { ...scope, wait_ms: 0 });
    expect(input.input?.turn_id).toBe("1");
    const [turn] = await db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.sessionId, sessionId),
          eq(schema.turns.sequence, 1),
        ),
      );
    return {
      sessionId,
      principal,
      scope: { ...scope, turn_id: "1" },
      turnRowId: turn?.id ?? 0,
      nextSequence: 1,
    };
  }

  function append(
    worker: Worker,
    decisions: unknown[] | undefined,
    sequence = worker.nextSequence,
  ) {
    worker.nextSequence = Math.max(worker.nextSequence, sequence + 1);
    return workers.appendEvents(
      worker.principal,
      appendEventsRequestSchema.parse({
        ...worker.scope,
        batch_key: `${worker.scope.attempt_id}:${sequence}-${sequence}`,
        events: [
          {
            event: "status",
            data: { phase: "running" },
            occurred_at: OCCURRED_AT,
            source_sequence: sequence,
          },
        ],
        ...(decisions === undefined ? {} : { tool_decisions: decisions }),
      }),
    );
  }

  const report = (overrides: Partial<ToolDecisionReport> = {}) => ({
    call_key: "t:toolu_1",
    tool_name: "Bash",
    tool_use_id: "toolu_1",
    input_sha256: SHA,
    input_bytes: 21,
    decision: "allow" as const,
    basis: "trusted_tool" as const,
    ...overrides,
  });

  const rowsOf = (sessionId: string) =>
    db
      .select()
      .from(schema.toolCallAudits)
      .where(eq(schema.toolCallAudits.sessionId, sessionId));

  test("a reported judgment is one row whose subject comes from the database", async () => {
    const worker = await startWorker();
    await append(worker, [report()]);
    const rows = await rowsOf(worker.sessionId);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row).toMatchObject({
      sessionId: worker.sessionId,
      ownerId: owner,
      turnId: 1,
      attemptId: worker.scope.attempt_id,
      callKey: "t:toolu_1",
      phase: "decided",
      toolName: "Bash",
      toolUseId: "toolu_1",
      mcpServer: null,
      inputSha256: SHA,
      inputBytes: 21,
      decision: "allow",
      basis: "trusted_tool",
      source: "worker_report",
      recordVersion: 1,
      pendingRequestId: null,
    });
    const [session] = await db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.id, worker.sessionId));
    expect(row?.workspaceId).toBe(session?.workspaceId ?? null);
    const [turn] = await db
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.id, worker.turnRowId));
    expect(row?.surface).toBe(turn?.channel ?? session?.channel ?? null);
    expect(row?.actorUserId).toBe(turn?.actorId ?? null);
  }, 60_000);

  test("a worker cannot name the subject: a report with subject fields is dropped", async () => {
    const worker = await startWorker();
    findings = [];
    const lie = {
      ...report({ call_key: "t:lie" }),
      workspace_id: crypto.randomUUID(),
      owner_id: "someone-else",
      surface: "slack",
    };
    const accepted = await append(worker, [lie, report()]);
    expect(accepted.accepted_through).toBe(1);
    const rows = await rowsOf(worker.sessionId);
    expect(rows.map((row) => row.callKey)).toEqual(["t:toolu_1"]);
    expect(rows[0]?.ownerId).toBe(owner);
    expect(findings).toEqual([
      expect.objectContaining({ dropped: 1, conflicts: 0, unverified: 0 }),
    ]);
  }, 60_000);

  test("a resent batch adds no rows", async () => {
    const worker = await startWorker();
    await append(worker, [report()], 1);
    await append(worker, [report()], 1);
    expect(await rowsOf(worker.sessionId)).toHaveLength(1);
  }, 60_000);

  test("the same call reported differently keeps the first and warns", async () => {
    const worker = await startWorker();
    findings = [];
    await append(worker, [report()]);
    await append(worker, [
      report({
        decision: "deny",
        basis: "not_permitted",
        input_sha256: OTHER_SHA,
      }),
    ]);
    const rows = await rowsOf(worker.sessionId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ decision: "allow", inputSha256: SHA });
    expect(findings).toEqual([expect.objectContaining({ conflicts: 1 })]);
  }, 60_000);

  test("a resend that differs only in the parent call or the request is a conflict", async () => {
    const worker = await startWorker();
    findings = [];
    await append(worker, [report()]);
    await append(worker, [report({ parent_tool_use_id: "toolu_parent" })]);
    await append(worker, [report({ pending_request_id: "req_other" })]);
    expect(findings).toEqual([
      expect.objectContaining({ conflicts: 1 }),
      expect.objectContaining({ conflicts: 1 }),
    ]);
    expect(await rowsOf(worker.sessionId)).toHaveLength(1);
  }, 60_000);

  test("an id outside the allowed alphabet is not stored", async () => {
    const worker = await startWorker();
    await append(worker, [
      report({
        call_key: "n:1",
        tool_name: "mcp__bad server__x",
        tool_use_id: "has space",
        parent_tool_use_id: "a;b",
      }),
    ]);
    const [row] = await rowsOf(worker.sessionId);
    expect(row).toMatchObject({
      toolName: "invalid_tool_name",
      toolUseId: null,
      parentToolUseId: null,
      mcpServer: null,
    });
  }, 60_000);

  test("the table has no column that could hold input text or a result", async () => {
    const columns = await db.execute<{ column_name: string }>(
      sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'tool_call_audits' ORDER BY column_name`,
    );
    const names = (columns.rows as Array<{ column_name: string }>).map(
      (column) => column.column_name,
    );
    expect(names).toEqual(
      [
        "agent_id",
        "agent_release_id",
        "actor_user_id",
        "answer_decision_id",
        "answer_surface",
        "answered_by",
        "at",
        "attempt_id",
        "basis",
        "call_key",
        "decision",
        "id",
        "input_bytes",
        "input_sha256",
        "mcp_server",
        "owner_id",
        "parent_tool_use_id",
        "pending_request_id",
        "phase",
        "principal_id",
        "principal_kind",
        "record_version",
        "session_id",
        "source",
        "surface",
        "tool_name",
        "tool_use_id",
        "turn_id",
        "workspace_id",
      ].sort(),
    );
  }, 60_000);

  test("a failed audit insert rolls the events back with it", async () => {
    const worker = await startWorker();
    await pool.query(
      "ALTER TABLE tool_call_audits ADD CONSTRAINT boom CHECK (false) NOT VALID",
    );
    try {
      await expect(append(worker, [report()])).rejects.toBeDefined();
    } finally {
      await pool.query("ALTER TABLE tool_call_audits DROP CONSTRAINT boom");
    }
    const events = await db
      .select()
      .from(schema.events)
      .where(eq(schema.events.sessionId, worker.sessionId));
    expect(
      events.filter((event) => event.attemptId === worker.scope.attempt_id),
    ).toHaveLength(0);
    expect(await rowsOf(worker.sessionId)).toHaveLength(0);
    worker.nextSequence = 1;
    const retried = await append(worker, [report()], 1);
    expect(retried.accepted_through).toBe(1);
    expect(await rowsOf(worker.sessionId)).toHaveLength(1);
  }, 60_000);

  test("a refused append leaves no audit row", async () => {
    const worker = await startWorker();
    await append(worker, undefined, 1);
    const clash = workers.appendEvents(worker.principal, {
      ...worker.scope,
      batch_key: "clash",
      events: [
        {
          event: "status",
          data: { phase: "idle" },
          occurred_at: new Date().toISOString(),
          source_sequence: 1,
        },
      ],
      tool_decisions: [report()],
    });
    await expect(clash).rejects.toBeDefined();
    expect(await rowsOf(worker.sessionId)).toHaveLength(0);
  }, 60_000);

  test("it records with tracing off: no tracer, no OTEL_TRACES_EXPORTER", async () => {
    expect(process.env.OTEL_TRACES_EXPORTER).toBeUndefined();
    const worker = await startWorker();
    await append(worker, [report()]);
    expect(await rowsOf(worker.sessionId)).toHaveLength(1);
  }, 60_000);

  describe("an approval claim is checked against the request (design 7.3.1)", () => {
    const REQUEST_HASH = "c".repeat(64);

    async function ask(
      worker: Worker,
      options: {
        id?: string;
        tool?: string;
        toolUseId?: string | null;
        answer?: "allow" | "deny" | null;
        inputHash?: string;
        attemptId?: string;
        expiresAt?: Date;
        settledOutcome?: string;
      } = {},
    ): Promise<string> {
      const requestId = options.id ?? `req_${crypto.randomUUID()}`;
      const answered = options.answer !== undefined && options.answer !== null;
      await db.insert(schema.pendingRequests).values({
        requestId,
        sessionId: worker.sessionId,
        turnId: worker.turnRowId,
        attemptId: options.attemptId ?? worker.scope.attempt_id,
        kind: "permission",
        payload: { kind: "permission", tool: "Bash", input: {} },
        inputHash: options.inputHash ?? REQUEST_HASH,
        expiresAt: options.expiresAt ?? new Date(Date.now() + 600_000),
        tool: options.tool ?? "Bash",
        toolUseId:
          options.toolUseId === undefined ? "toolu_1" : options.toolUseId,
        ...(answered
          ? {
              answer: { decision: options.answer },
              answeredAt: new Date(),
              resolvedAt: new Date(),
              answeredBy: { kind: "user", user_id: crypto.randomUUID() },
              answerSurface: "web",
              answerDecisionId: crypto.randomUUID(),
            }
          : {}),
        ...(options.settledOutcome === undefined
          ? {}
          : { settledOutcome: options.settledOutcome, resolvedAt: new Date() }),
      });
      return requestId;
    }

    const approved = (requestId: string, overrides = {}) =>
      report({
        decision: "allow",
        basis: "approval",
        pending_request_id: requestId,
        approval_input_hash: REQUEST_HASH,
        ...overrides,
      });

    async function only(worker: Worker) {
      const rows = await rowsOf(worker.sessionId);
      expect(rows).toHaveLength(1);
      return rows[0];
    }

    test("a request the person approved grounds the call and is copied", async () => {
      const worker = await startWorker();
      const requestId = await ask(worker, { answer: "allow" });
      await append(worker, [approved(requestId)]);
      const row = await only(worker);
      const [request] = await db
        .select()
        .from(schema.pendingRequests)
        .where(eq(schema.pendingRequests.requestId, requestId));
      expect(row).toMatchObject({
        decision: "allow",
        basis: "approval",
        pendingRequestId: requestId,
        answerSurface: "web",
        answerDecisionId: request?.answerDecisionId,
      });
      expect(row?.answeredBy).toEqual(request?.answeredBy ?? null);
    }, 60_000);

    test("a denial, an expiry and a cancel are grounded the same way", async () => {
      const worker = await startWorker();
      const denied = await ask(worker, {
        answer: "deny",
        toolUseId: "toolu_d",
      });
      const expired = await ask(worker, {
        toolUseId: "toolu_e",
        expiresAt: new Date(Date.now() - 1_000),
      });
      const cancelled = await ask(worker, {
        toolUseId: "toolu_c",
        settledOutcome: "cancelled",
      });
      const claim = (
        key: string,
        id: string,
        basis: ToolDecisionReport["basis"],
      ) =>
        report({
          call_key: `t:${key}`,
          tool_use_id: key,
          decision: "deny",
          basis,
          pending_request_id: id,
          approval_input_hash: REQUEST_HASH,
        });
      await append(worker, [
        claim("toolu_d", denied, "approval_denied"),
        claim("toolu_e", expired, "approval_expired"),
        claim("toolu_c", cancelled, "approval_cancelled"),
      ]);
      const rows = await rowsOf(worker.sessionId);
      expect(rows.map((row) => row.basis).sort()).toEqual([
        "approval_cancelled",
        "approval_denied",
        "approval_expired",
      ]);
      expect(rows.every((row) => row.decision === "deny")).toBe(true);
    }, 60_000);

    const failures: Array<[string, (worker: Worker) => Promise<unknown[]>]> = [
      [
        "1: no such request in this session",
        async () => [approved(`req_${crypto.randomUUID()}`)],
      ],
      [
        "2: the request was for another tool",
        async (worker) => [
          approved(await ask(worker, { answer: "allow", tool: "Write" })),
        ],
      ],
      [
        "3: the arguments hash differs",
        async (worker) => [
          approved(await ask(worker, { answer: "allow" }), {
            approval_input_hash: OTHER_SHA,
          }),
        ],
      ],
      [
        "4: the person denied it",
        async (worker) => [approved(await ask(worker, { answer: "deny" }))],
      ],
      [
        "4: nobody answered",
        async (worker) => [approved(await ask(worker, {}))],
      ],
      [
        "5: the approval was for another call",
        async (worker) => [
          approved(
            await ask(worker, { answer: "allow", toolUseId: "toolu_x" }),
          ),
        ],
      ],
      [
        "5: the approval was for another attempt",
        async (worker) => [
          approved(
            await ask(worker, { answer: "allow", attemptId: "att_other" }),
          ),
        ],
      ],
    ];
    for (const [name, build] of failures) {
      test(`check ${name} is written as unknown/approval_unverified`, async () => {
        const worker = await startWorker();
        findings = [];
        await append(worker, await build(worker));
        const row = await only(worker);
        expect(row).toMatchObject({
          decision: "unknown",
          basis: "approval_unverified",
          pendingRequestId: null,
          answeredBy: null,
        });
        expect(findings).toEqual([expect.objectContaining({ unverified: 1 })]);
      }, 60_000);
    }

    test("check 5: a resumed turn's grant carries the approval over", async () => {
      const worker = await startWorker();
      const requestId = await ask(worker, {
        answer: "allow",
        toolUseId: "toolu_old",
        attemptId: "att_before_the_park",
      });
      await db.insert(schema.permissionGrants).values({
        requestId,
        sessionId: worker.sessionId,
        turnId: worker.turnRowId,
        attemptId: worker.scope.attempt_id,
      });
      await append(worker, [approved(requestId)]);
      expect(await only(worker)).toMatchObject({
        basis: "approval",
        pendingRequestId: requestId,
      });
    }, 60_000);

    test("check 6: one approval grounds one call", async () => {
      const worker = await startWorker();
      const requestId = await ask(worker, { answer: "allow" });
      await append(worker, [approved(requestId)]);
      await append(worker, [
        approved(requestId, { call_key: "t:toolu_2", tool_use_id: "toolu_2" }),
      ]);
      const rows = await rowsOf(worker.sessionId);
      const byKey = new Map(rows.map((row) => [row.callKey, row]));
      expect(byKey.get("t:toolu_1")?.basis).toBe("approval");
      expect(byKey.get("t:toolu_2")).toMatchObject({
        decision: "unknown",
        basis: "approval_unverified",
        pendingRequestId: null,
      });
    }, 60_000);

    test("a request the sweep expired cannot be reported as cancelled, nor a cancelled one as expired", async () => {
      const worker = await startWorker();
      const settled = await ask(worker, {
        toolUseId: "toolu_s",
        settledOutcome: "expired",
      });
      const swept = await ask(worker, {
        toolUseId: "toolu_w",
        expiresAt: new Date(Date.now() - 2_000),
      });
      await db
        .update(schema.pendingRequests)
        .set({ resolvedAt: new Date() })
        .where(eq(schema.pendingRequests.requestId, swept));
      const early = await ask(worker, {
        toolUseId: "toolu_x",
        settledOutcome: "cancelled",
      });
      const claim = (
        key: string,
        id: string,
        basis: ToolDecisionReport["basis"],
      ) =>
        report({
          call_key: `t:${key}`,
          tool_use_id: key,
          decision: "deny",
          basis,
          pending_request_id: id,
          approval_input_hash: REQUEST_HASH,
        });
      await append(worker, [
        claim("toolu_s", settled, "approval_cancelled"),
        claim("toolu_w", swept, "approval_cancelled"),
        claim("toolu_x", early, "approval_expired"),
      ]);
      const rows = await rowsOf(worker.sessionId);
      expect(rows.map((row) => row.basis)).toEqual([
        "approval_unverified",
        "approval_unverified",
        "approval_unverified",
      ]);
    }, 60_000);

    test("check 6 does not turn a resend into a second use", async () => {
      const worker = await startWorker();
      const requestId = await ask(worker, { answer: "allow" });
      await append(worker, [approved(requestId)], 1);
      await append(worker, [approved(requestId)], 1);
      const row = await only(worker);
      expect(row?.basis).toBe("approval");
    }, 60_000);
  });

  describe("the asked row", () => {
    test("a request id outside the allowed alphabet is kept out of the row and its key", async () => {
      const worker = await startWorker();
      const requestId = "req with space\nand a line";
      await workers.registerPending(worker.principal, {
        ...worker.scope,
        request_id: requestId,
        input_hash: "d".repeat(64),
        request: { kind: "permission", tool: "Bash", input: {} },
        announce: { tool_use_id: "has space", tool: "Bash" },
      });
      const [row] = await rowsOf(worker.sessionId);
      expect(row?.pendingRequestId).toBeNull();
      expect(row?.toolUseId).toBeNull();
      expect(row?.callKey).toMatch(/^r:[0-9a-f]{32}$/);
      expect(JSON.stringify(row)).not.toContain("with space");
    }, 60_000);

    test("the registration writes it in its own transaction, once", async () => {
      const worker = await startWorker();
      const requestId = `req_${crypto.randomUUID()}`;
      const registration = {
        ...worker.scope,
        request_id: requestId,
        input_hash: "d".repeat(64),
        request: {
          kind: "permission" as const,
          tool: "mcp__github__create_issue",
          input: { title: "synthetic-secret-value-for-test" },
        },
        announce: {
          tool_use_id: "toolu_ask",
          tool: "mcp__github__create_issue",
        },
      };
      await workers.registerPending(worker.principal, registration);
      await workers.registerPending(worker.principal, registration);
      const rows = await rowsOf(worker.sessionId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        phase: "asked",
        decision: "require_approval",
        basis: "approval_asked",
        source: "platform",
        callKey: "t:toolu_ask",
        toolName: "mcp__github__create_issue",
        mcpServer: "github",
        pendingRequestId: requestId,
        inputSha256: null,
        inputBytes: null,
      });
      expect(JSON.stringify(rows)).not.toContain("synthetic-secret-value");
    }, 60_000);
  });

  test("a judgment for no turn is left out and the events still land", async () => {
    const worker = await startWorker();
    const scope = { ...worker.scope, turn_id: null };
    const stored = await workers.appendEvents(worker.principal, {
      ...scope,
      batch_key: "no-turn",
      events: [
        {
          event: "status",
          data: { phase: "running" },
          occurred_at: new Date().toISOString(),
          source_sequence: 1,
        },
      ],
      tool_decisions: [report()],
    });
    expect(stored.accepted_through).toBe(1);
    expect(await rowsOf(worker.sessionId)).toHaveLength(0);
  }, 60_000);
});
