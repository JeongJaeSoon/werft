import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as schema from "@werft-ai/db";
import {
  apiKeys,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import { TEST_MODEL } from "@werft-ai/db/testing/spec-pins";
import { acceptAllCheckpoints, createWorkerGateway } from "@werft-ai/platform";
import {
  createTempDatabase,
  type TempDatabase,
  testDatabaseUrl,
} from "@werft-ai/testkit/postgres";
import { eq } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { seedSettings, settingsDocument } from "../test-support/settings.ts";
import { testCatalog } from "../testing/catalog.ts";
import { allowRepositories, releaseIn } from "../testing/releases.ts";
import { SHUTDOWN_DRAIN_MS } from "./shutdown.ts";

const integration = testDatabaseUrl() ? describe : describe.skip;
const MASTER_KEY = "ab".repeat(32);
let databaseUrl: string;

// Thirty seconds leaves room for server startup under CI load while still
// classifying a hang promptly. The test timeout is a separate total budget:
// key CLI spawn + DB insert before the wait, the full startup allowance, then
// the remaining requests and teardown.
const SERVER_START_DEADLINE_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 100;

// Drains the server's stdout and resolves `port` from its "API listening"
// line. The server binds PORT=0 so the OS hands it a free port: a port picked
// here (it was pid-derived) can already be held on a shared runner, and the
// bind then fails. `port` resolves undefined if stdout ends first.
function serverStdout(stream: ReadableStream<Uint8Array>): {
  text: Promise<string>;
  port: Promise<number | undefined>;
} {
  let found: (port: number | undefined) => void = () => {};
  const port = new Promise<number | undefined>((resolve) => {
    found = resolve;
  });
  const text = (async () => {
    const decoder = new TextDecoder();
    let all = "";
    let scanned = 0;
    for await (const chunk of stream) {
      all += decoder.decode(chunk, { stream: true });
      for (
        let newline = all.indexOf("\n", scanned);
        newline >= 0;
        newline = all.indexOf("\n", scanned)
      ) {
        const line = all.slice(scanned, newline);
        scanned = newline + 1;
        if (!line.includes('"API listening"')) continue;
        const record = JSON.parse(line) as { fields?: { port?: number } };
        found(record.fields?.port);
      }
    }
    found(undefined);
    return all + decoder.decode();
  })();
  return { text, port };
}

// Waits for the server to report its port, then polls `path` on it until the
// server answers, the server exits, or the deadline passes. Exit and deadline
// both fail with the server's stderr attached, so a startup error (missing
// DATABASE_URL, module failure) is readable from the assertion instead of
// surfacing as an `undefined` status. Each wait is bounded by the deadline so
// a server that never listens, or accepts the connection but never answers,
// still ends here, not at the test timeout.
async function waitForServer(
  server: Bun.Subprocess,
  stdout: { port: Promise<number | undefined> },
  stderr: Promise<string>,
  request: { path: string; headers: Record<string, string> },
): Promise<{ port: number; response: Response }> {
  const exited = server.exited.then((exitCode) => ({ exitCode }));
  const deadline = Date.now() + SERVER_START_DEADLINE_MS;
  const fail = async (reason: string): Promise<never> => {
    server.kill("SIGTERM");
    await server.exited;
    throw new Error(`${reason}\nstderr:\n${await stderr}`);
  };
  const exitedEarly = async (exitCode: number): Promise<never> => {
    throw new Error(
      `server exited with code ${exitCode} before accepting connections\nstderr:\n${await stderr}`,
    );
  };

  const listening = await Promise.race([
    stdout.port.then((port) => ({ port })),
    exited,
    Bun.sleep(SERVER_START_DEADLINE_MS).then(() => ({ timedOut: true })),
  ]);
  if ("exitCode" in listening) return exitedEarly(listening.exitCode);
  if ("timedOut" in listening || listening.port === undefined) {
    return fail(
      `server did not report a listening port within ${SERVER_START_DEADLINE_MS}ms`,
    );
  }
  const { port } = listening;

  while (true) {
    const outcome = await Promise.race([
      fetch(`http://127.0.0.1:${port}${request.path}`, {
        headers: request.headers,
        signal: AbortSignal.timeout(Math.max(deadline - Date.now(), 1)),
      }).then(
        (response) => ({ response }),
        (error: unknown) => ({ error }),
      ),
      exited,
    ]);
    if ("response" in outcome) return { port, response: outcome.response };
    if ("exitCode" in outcome) return exitedEarly(outcome.exitCode);
    if (Date.now() >= deadline) {
      return fail(
        `server did not accept connections within ${SERVER_START_DEADLINE_MS}ms (last error: ${String(outcome.error)})`,
      );
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }
}

// The provider key the catalog below references by environment variable.
// The server must start with it and never write it anywhere.
const PROVIDER_KEY = `provider-${crypto.randomUUID()}`;
const CONNECTIONS = `connections:
  test-connection:
    kind: anthropic
    endpoint: https://api.anthropic.invalid
    models: [claude-sonnet-5]
    auth:
      kind: api_key
      value_env: INTEGRATION_PROVIDER_KEY
`;
const REPOSITORIES = `repositories:
  app:
    url: https://github.com/team/app.git
    branch: main
    auth:
      kind: github_app
`;

/** A personal key of `userId` in workspace `ownerId`, as the CLI issues it. */
const keyUserId = crypto.randomUUID();

async function issueKey(
  ownerId: string,
  scopes: string,
): Promise<{ plaintext: string; keyId: string }> {
  const keyProcess = Bun.spawn(
    [
      "bun",
      "run",
      "src/api/keys.ts",
      "create",
      "--workspace",
      ownerId,
      "--personal",
      keyUserId,
      "--scopes",
      scopes,
    ],
    {
      cwd: `${import.meta.dir}/../..`,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [keyOutput, keyError, keyExit] = await Promise.all([
    new Response(keyProcess.stdout).text(),
    new Response(keyProcess.stderr).text(),
    keyProcess.exited,
  ]);
  expect(keyExit, keyError).toBe(0);
  expect(keyOutput.trim().split("\n")).toHaveLength(1);
  const plaintext = keyOutput.trim();
  expect(plaintext).toStartWith("csp_");
  const keyId = /^key_id (\S+)$/m.exec(keyError)?.[1];
  expect(keyId, keyError).toBeDefined();
  return { plaintext, keyId: keyId ?? "" };
}

async function grantsCli(
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return cli("src/api/grants.ts", args);
}

async function keysCli(
  ...args: string[]
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return cli("src/api/keys.ts", args);
}

async function cli(
  script: string,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["bun", "run", script, ...args], {
    cwd: `${import.meta.dir}/../..`,
    env: { ...Bun.env, DATABASE_URL: databaseUrl },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, stdout, stderr };
}

// Runs the server to exit and hands back what it said; for configurations
// that must stop it before it ever listens.
async function refusedStart(
  env: Record<string, string>,
): Promise<{ exitCode: number; stderr: string }> {
  const server = Bun.spawn(["bun", "run", "src/main.ts", "api"], {
    cwd: `${import.meta.dir}/../..`,
    env: {
      ...process.env,
      AUTH_MODE: "api-key",
      CHECKPOINT_OBJECT_STORE: "disabled",
      DATABASE_URL: databaseUrl,
      EXECUTION_SLOT_LIMIT: "10",
      MAX_TURN_SECONDS: "3600",
      PROVIDER_MAX_RETRIES: "2",
      QUEUED_INPUT_LIMIT_PER_SESSION: "20",
      SESSION_COST_LIMIT_USD: "25",
      STORAGE_LIMIT_BYTES: "1073741824",
      PORT: "0",
      INTEGRATION_PROVIDER_KEY: PROVIDER_KEY,
      PLATFORM_SECRET_KEY: MASTER_KEY,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(
    () => server.kill("SIGKILL"),
    SERVER_START_DEADLINE_MS,
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(server.stdout).text(),
    new Response(server.stderr).text(),
    server.exited,
  ]);
  clearTimeout(timer);
  return { exitCode, stderr: `${stdout}${stderr}` };
}

// One HTTP/1.1 connection opened before shutdown. Bun keeps serving a
// connection it already holds after the listener stops accepting, so this is
// the only way left to read /readyz once shutdown has started.
async function heldConnection(port: number) {
  const socket = connect(port, "127.0.0.1");
  let received = "";
  let wake = () => {};
  socket.on("data", (chunk) => {
    received += chunk.toString();
    wake();
  });
  socket.on("close", () => wake());
  await once(socket, "connect");
  return {
    async get(path: string): Promise<{ status: number; body: string }> {
      received = "";
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n`);
      const deadline = Date.now() + 5_000;
      for (;;) {
        const head = received.indexOf("\r\n\r\n");
        const length = Number(
          /^content-length: (\d+)$/im.exec(received.slice(0, head))?.[1],
        );
        if (head >= 0 && received.length >= head + 4 + length) {
          return {
            status: Number(received.slice(9, 12)),
            body: received.slice(head + 4, head + 4 + length),
          };
        }
        if (socket.destroyed || Date.now() > deadline) {
          throw new Error(`no response to ${path}; got ${received}`);
        }
        await Promise.race([
          new Promise<void>((resolve) => {
            wake = resolve;
          }),
          Bun.sleep(deadline - Date.now()),
        ]);
      }
    },
    close: () => socket.destroy(),
  };
}

integration("API server on PostgreSQL", () => {
  let database: TempDatabase;
  let db: NodePgDatabase<typeof schema>;
  let pool: Pool;
  let root: string;
  // The workspace the keys belong to; a session runs one of its releases.
  const ownerId = crypto.randomUUID();
  let releaseId = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "server-integration-"));
    database = await createTempDatabase({ prefix: "server_it" });
    databaseUrl = database.url;
    pool = new Pool({ connectionString: databaseUrl, max: 2 });
    db = drizzle(pool, { schema });
    await seedSettings(db, settingsDocument(CONNECTIONS, REPOSITORIES));
    releaseId = await releaseIn(db, ownerId);
    // "missing" is inside the ceiling but not in the catalog.
    await allowRepositories(db, ownerId, ["app", "missing"]);
    await db.insert(schema.users).values({
      id: keyUserId,
      email: `${keyUserId}@example.invalid`,
      passwordHash: "argon2id$placeholder",
      displayName: "key holder",
    });
    await db
      .insert(schema.memberships)
      .values({ workspaceId: ownerId, userId: keyUserId, role: "owner" });
  }, 60_000);

  afterAll(async () => {
    await pool.end();
    await database.drop();
    await rm(root, { recursive: true, force: true });
  }, 60_000);

  test(
    "issues scoped keys that store a digest, and serves the catalog and scopes over HTTP",
    async () => {
      const { plaintext } = await issueKey(
        ownerId,
        "sessions:read,sessions:write",
      );
      const { plaintext: readOnly, keyId: readOnlyId } = await issueKey(
        ownerId,
        "sessions:read",
      );
      const { plaintext: owner } = await issueKey(
        ownerId,
        "sessions:read,sessions:write,sessions:approve,sessions:control,sessions:recover",
      );

      const stored = await db
        .select({ keyHash: apiKeys.keyHash, scopes: apiKeys.scopes })
        .from(apiKeys)
        .where(eq(apiKeys.ownerId, ownerId));
      expect(stored.map((row) => row.scopes)).toContainEqual([
        "sessions:read",
        "sessions:write",
      ]);
      for (const row of stored) {
        expect(row.keyHash).toHaveLength(32);
        for (const key of [plaintext, readOnly, owner]) {
          expect(new TextDecoder().decode(row.keyHash)).not.toContain(key);
        }
      }

      const server = Bun.spawn(["bun", "run", "src/main.ts", "api"], {
        cwd: `${import.meta.dir}/../..`,
        env: {
          ...process.env,
          AUTH_MODE: "api-key",
          // The process refuses to start without an object store unless told
          // there is none; this test is about the HTTP process, not S3.
          CHECKPOINT_OBJECT_STORE:
            process.env.CHECKPOINT_OBJECT_STORE ?? "disabled",
          DATABASE_URL: databaseUrl,
          EXECUTION_SLOT_LIMIT: "10",
          MAX_TURN_SECONDS: "3600",
          PROVIDER_MAX_RETRIES: "2",
          QUEUED_INPUT_LIMIT_PER_SESSION: "20",
          SESSION_COST_LIMIT_USD: "25",
          STORAGE_LIMIT_BYTES: "1073741824",
          PORT: "0",
          PLATFORM_SECRET_KEY: MASTER_KEY,
          INTEGRATION_PROVIDER_KEY: PROVIDER_KEY,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      // Drain both pipes from the start so a chatty server never blocks on a
      // full pipe, and so the same text serves the failure message and the
      // leak assertion below.
      const stdout = serverStdout(server.stdout);
      const serverStderr = new Response(server.stderr).text();
      let exitCode: number | undefined;

      try {
        const { port, response: accepted } = await waitForServer(
          server,
          stdout,
          serverStderr,
          {
            path: "/v1",
            headers: { Authorization: `Bearer ${plaintext}` },
          },
        );
        expect(accepted.status).toBe(200);
        expect(await accepted.json()).toEqual({
          status: "ok",
          owner_id: ownerId,
        });

        const rejected = await fetch(`http://127.0.0.1:${port}/v1`, {
          headers: { Authorization: "Bearer wrong" },
        });
        expect(rejected.status).toBe(401);
        const forged = await fetch(`http://127.0.0.1:${port}/v1`, {
          headers: { "X-Owner-Id": "forged-owner" },
        });
        expect(forged.status).toBe(401);

        const call = (
          key: string,
          method: string,
          path: string,
          body?: unknown,
        ) =>
          fetch(`http://127.0.0.1:${port}/v1${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${key}`,
              "Content-Type": "application/json",
              "Idempotency-Key": crypto.randomUUID(),
            },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          });

        // The catalog is what the database says: a repository it does not
        // register is 422, a release of no agent here 404, and a release
        // on a registered repository is accepted.
        const unknown = await call(plaintext, "POST", "/sessions", {
          agent_release_id: releaseId,
          repository_id: "missing",
          message: "hi",
        });
        expect(unknown.status).toBe(422);
        const stranger = await call(plaintext, "POST", "/sessions", {
          agent_release_id: `sha256:${"0".repeat(64)}`,
          repository_id: "app",
          message: "hi",
        });
        expect(stranger.status).toBe(404);
        const created = await call(plaintext, "POST", "/sessions", {
          agent_release_id: releaseId,
          repository_id: "app",
          message: "hi",
        });
        expect(created.status).toBe(201);
        const { session_id: sessionId } = (await created.json()) as {
          session_id: string;
        };

        // A key without the scope is refused before anything is read or
        // changed: sessions:recover is its own scope, which
        // sessions:write does not include.
        const before = await (
          await call(readOnly, "GET", `/sessions/${sessionId}`)
        ).json();
        const decision = {
          decision: "close",
          reason: "integration",
        };
        for (const key of [readOnly, plaintext]) {
          const refused = await call(
            key,
            "POST",
            `/sessions/${sessionId}/recovery-decisions`,
            decision,
          );
          expect(refused.status).toBe(403);
          expect(await refused.json()).toMatchObject({
            error: { code: "FORBIDDEN" },
          });
        }
        const writeWithoutScope = await call(readOnly, "POST", "/sessions", {
          agent_release_id: releaseId,
          repository_id: "app",
          message: "hi",
        });
        expect(writeWithoutScope.status).toBe(403);
        expect(
          await (await call(readOnly, "GET", `/sessions/${sessionId}`)).json(),
        ).toEqual(before);
        // The same request with the scope gets past the policy to the
        // service, which judges the session itself.
        const admitted = await call(
          owner,
          "POST",
          `/sessions/${sessionId}/recovery-decisions`,
          decision,
        );
        expect(admitted.status).not.toBe(403);
        expect(admitted.status).toBeLessThan(500);

        // the operator command revokes one key; the server has no
        // key cache, so the very next request with it is 401 and the other
        // keys of the same owner keep working.
        const revoked = await keysCli("revoke", readOnlyId);
        expect(revoked.exitCode, revoked.stderr).toBe(0);
        expect(revoked.stdout).toStartWith(`revoked ${readOnlyId} `);
        expect(
          (await call(readOnly, "GET", `/sessions/${sessionId}`)).status,
        ).toBe(401);
        expect(
          (await call(plaintext, "GET", `/sessions/${sessionId}`)).status,
        ).toBe(200);
        const again = await keysCli("revoke", readOnlyId);
        expect(again.exitCode, again.stderr).toBe(0);
        expect(again.stdout).toStartWith(`already_revoked ${readOnlyId} `);
        const missing = await keysCli("revoke", crypto.randomUUID());
        expect(missing.exitCode).toBe(1);
        expect(missing.stderr).toContain("not found");

        // The operator's execution revocation: the session stops, and its
        // owner, whose key still works, cannot bring it back.
        const grant = await grantsCli(
          "revoke",
          sessionId,
          "--reason",
          "integration",
        );
        expect(grant.exitCode, grant.stderr).toBe(0);
        expect(grant.stdout).toStartWith(`revoked ${sessionId} `);
        expect(grant.stdout).toContain("receipt_status=succeeded");
        const stopped = (await (
          await call(owner, "GET", `/sessions/${sessionId}`)
        ).json()) as { admission_state: string; revision: number };
        expect(stopped.admission_state).toBe("stopped");
        const resumed = await call(
          owner,
          "POST",
          `/sessions/${sessionId}/resume`,
          { expected_revision: stopped.revision },
        );
        expect(resumed.status).toBe(403);
        expect(await resumed.json()).toMatchObject({
          error: { code: "FORBIDDEN" },
        });
        const restored = await grantsCli(
          "restore",
          sessionId,
          "--reason",
          "integration",
        );
        expect(restored.exitCode, restored.stderr).toBe(0);
        expect(restored.stdout).toStartWith(`restored ${sessionId} `);
      } finally {
        server.kill("SIGTERM");
        exitCode = await server.exited;
      }

      const logs = `${await stdout.text}${await serverStderr}`;
      // SIGTERM is a clean stop: readiness first, pools last (shutdown.ts).
      expect(exitCode, logs).toBe(0);
      const order = [
        "Shutdown started; readiness withdrawn",
        "Stopped accepting connections",
        "In-flight requests drained",
        "Connections closed; exiting",
      ].map((message) => logs.indexOf(message));
      expect(
        order.every((at) => at >= 0),
        logs,
      ).toBe(true);
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(logs).not.toContain(plaintext);
      expect(logs).not.toContain("Authorization");
      expect(logs).not.toContain(PROVIDER_KEY);
      expect(logs).toContain("Session catalog loaded");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "SIGTERM withdraws readiness at once, answers the request in flight, refuses new connections and exits 0",
    async () => {
      const { plaintext } = await issueKey(ownerId, "sessions:read");
      const server = Bun.spawn(["bun", "run", "src/main.ts", "api"], {
        cwd: `${import.meta.dir}/../..`,
        env: {
          ...process.env,
          AUTH_MODE: "api-key",
          CHECKPOINT_OBJECT_STORE: "disabled",
          DATABASE_URL: databaseUrl,
          EXECUTION_SLOT_LIMIT: "10",
          MAX_TURN_SECONDS: "3600",
          PROVIDER_MAX_RETRIES: "2",
          QUEUED_INPUT_LIMIT_PER_SESSION: "20",
          SESSION_COST_LIMIT_USD: "25",
          STORAGE_LIMIT_BYTES: "1073741824",
          PORT: "0",
          PLATFORM_SECRET_KEY: MASTER_KEY,
          INTEGRATION_PROVIDER_KEY: PROVIDER_KEY,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = serverStdout(server.stdout);
      const serverStderr = new Response(server.stderr).text();
      const blocker = await pool.connect();
      let held: Awaited<ReturnType<typeof heldConnection>> | undefined;
      let exitCode: number | undefined;
      try {
        const { port } = await waitForServer(server, stdout, serverStderr, {
          path: "/healthz",
          headers: {},
        });
        held = await heldConnection(port);
        await held.get("/healthz");

        // The key lookup waits on this lock, so the request stays in flight
        // across the signal until the lock goes.
        await blocker.query("BEGIN");
        await blocker.query("LOCK TABLE api_keys IN ACCESS EXCLUSIVE MODE");
        const inFlight = fetch(`http://127.0.0.1:${port}/v1`, {
          headers: { Authorization: `Bearer ${plaintext}` },
        });
        let settled = false;
        const settle = () => {
          settled = true;
        };
        inFlight.then(settle, settle);
        const blocked = async () =>
          (
            await pool.query<{ n: number }>(
              `SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
                  AND query ILIKE '%api_keys%' AND pid <> pg_backend_pid()`,
            )
          ).rows[0]?.n ?? 0;
        const blockedBy = Date.now() + SERVER_START_DEADLINE_MS;
        while ((await blocked()) === 0) {
          expect(settled).toBe(false);
          expect(Date.now()).toBeLessThan(blockedBy);
          await Bun.sleep(POLL_INTERVAL_MS);
        }

        const signalledAt = Date.now();
        server.kill("SIGTERM");
        let readiness = await held.get("/readyz");
        // Until the signal is handled the probe still answers for itself.
        while (!readiness.body.includes("shutdown")) {
          expect(Date.now() - signalledAt).toBeLessThan(5_000);
          await Bun.sleep(20);
          readiness = await held.get("/readyz");
        }
        expect(readiness.status).toBe(503);
        held.close();

        // Readiness and the listener stop in one step, so the listener is
        // already closed here.
        const fresh = connect(port, "127.0.0.1");
        const outcome = await Promise.race([
          once(fresh, "error").then(
            ([error]) => (error as NodeJS.ErrnoException).code,
          ),
          once(fresh, "connect").then(() => "connected"),
        ]);
        fresh.destroy();
        expect(outcome).toBe("ECONNREFUSED");

        await blocker.query("ROLLBACK");
        const answered = await inFlight;
        expect(answered.status).toBe(200);
        expect(await answered.json()).toEqual({
          status: "ok",
          owner_id: ownerId,
        });
        exitCode = await server.exited;
        expect(Date.now() - signalledAt).toBeLessThan(SHUTDOWN_DRAIN_MS);
      } finally {
        held?.close();
        await blocker.query("ROLLBACK").catch(() => {});
        blocker.release();
        if (exitCode === undefined) {
          server.kill("SIGKILL");
          await server.exited;
        }
      }
      const logs = `${await stdout.text}${await serverStderr}`;
      expect(exitCode, logs).toBe(0);
      expect(logs).toContain("In-flight requests drained");
      expect(logs).not.toContain("Drain deadline passed");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "SIGTERM answers an open next-input long poll at once instead of draining it",
    async () => {
      // Its own repository, so the claim below cannot take a session another
      // suite queued in the shared database.
      const repositoryId = `long-poll-${crypto.randomUUID()}`;
      const gateway = createWorkerGateway({
        work: createPostgresWorkerUnitOfWork(db),
        catalog: testCatalog({
          provider: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            auth: {
              kind: "api_key",
              value: PROVIDER_KEY,
              ref: { value_env: "INTEGRATION_PROVIDER_KEY" },
            },
          },
          repositories: {
            [repositoryId]: {
              url: "https://github.com/team/app.git",
              branch: "main",
              auth: { kind: "github_app", registered: true } as const,
            },
          },
        }),
        checkpoints: acceptAllCheckpoints,
        options: {
          sessionCostLimitUsd: 25,
          sessionTokenLimit: null,
          leaseTtlMs: 30_000,
        },
      });
      const accepted = await createPostgresSessionUnitOfWork(
        db,
      ).acceptInputAtomic({
        limits: { queuedInputLimitPerSession: 20, storageLimitBytes: 1e9 },
        principal: { ownerId },
        idempotencyKey: crypto.randomUUID(),
        payloadHash: "hash",
        agentReleaseId: releaseId,
        model: TEST_MODEL,
        repository: {
          id: repositoryId,
          url: "https://github.com/team/app.git",
          branch: "main",
        },
        message: "first turn",
      });
      if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
      const launch = await launchSession(db, {
        sessionId: accepted.response.session_id,
      });
      const claimed = await gateway.bootstrapClaim(
        { kind: "bootstrap" },
        {
          execution_id: launch.executionId,
          execution_generation: launch.generation,
          credential: { kind: "launch_nonce", nonce: launch.nonce },
        },
      );
      const principal = {
        kind: "session",
        attemptId: claimed.attempt_id,
        sessionId: claimed.session_id,
        leaseEpoch: claimed.lease_epoch,
        executionGeneration: claimed.execution_generation,
        authRevision: claimed.auth_revision,
      } as const;
      const scope = {
        session_id: claimed.session_id,
        turn_id: null,
        attempt_id: claimed.attempt_id,
        lease_epoch: claimed.lease_epoch,
        execution_generation: claimed.execution_generation,
        auth_revision: claimed.auth_revision,
      };
      const first = await gateway.nextInput(principal, scope);
      if (!first.input) throw new Error("no input delivered");
      await gateway.finalize(principal, {
        ...scope,
        turn_id: first.input.turn_id,
        finalize_key: "fin-1",
        final_source_sequence: 0,
        terminal: {
          status: "completed",
          reason: null,
          result: null,
          usage: null,
        },
        checkpoint: null,
      });

      const server = Bun.spawn(["bun", "run", "src/main.ts", "api"], {
        cwd: `${import.meta.dir}/../..`,
        env: {
          ...process.env,
          AUTH_MODE: "api-key",
          CHECKPOINT_OBJECT_STORE: "disabled",
          DATABASE_URL: databaseUrl,
          EXECUTION_SLOT_LIMIT: "10",
          MAX_TURN_SECONDS: "3600",
          PROVIDER_MAX_RETRIES: "2",
          QUEUED_INPUT_LIMIT_PER_SESSION: "20",
          SESSION_COST_LIMIT_USD: "25",
          STORAGE_LIMIT_BYTES: "1073741824",
          PORT: "0",
          PLATFORM_SECRET_KEY: MASTER_KEY,
          INTEGRATION_PROVIDER_KEY: PROVIDER_KEY,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const stdout = serverStdout(server.stdout);
      const serverStderr = new Response(server.stderr).text();
      const waitMs = 20_000;
      let exitCode: number | undefined;
      try {
        const { port } = await waitForServer(server, stdout, serverStderr, {
          path: "/healthz",
          headers: {},
        });
        const poll = fetch(
          `http://127.0.0.1:${port}/internal/worker/next-input`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${claimed.session_credential}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ ...scope, wait_ms: waitMs }),
          },
        );
        let settled = false;
        const settle = () => {
          settled = true;
        };
        poll.then(settle, settle);
        await Bun.sleep(2_000);
        expect(settled).toBe(false);

        const signalledAt = Date.now();
        server.kill("SIGTERM");
        const answered = await poll;
        const answeredAfter = Date.now() - signalledAt;
        expect(answered.status).toBe(200);
        expect(await answered.json()).toMatchObject({ input: null });
        exitCode = await server.exited;
        const exitedAfter = Date.now() - signalledAt;
        expect(answeredAfter).toBeLessThan(2_000);
        expect(exitedAfter).toBeLessThan(waitMs / 2);
      } finally {
        if (exitCode === undefined) {
          server.kill("SIGKILL");
          await server.exited;
        }
      }
      const logs = `${await stdout.text}${await serverStderr}`;
      expect(exitCode, logs).toBe(0);
      expect(logs).toContain("In-flight requests drained");
      expect(logs).not.toContain("Drain deadline passed");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "a leftover file catalog, no master key or a bad HEARTBEAT_TTL_SEC stops the server",
    async () => {
      const leftover = await refusedStart({
        PLATFORM_CONFIG_DIR: "/app/config",
      });
      expect(leftover.exitCode).not.toBe(0);
      expect(leftover.stderr).toContain(
        "PLATFORM_CONFIG_DIR no longer read: finish the import",
      );

      const keyless = await refusedStart({ PLATFORM_SECRET_KEY: "" });
      expect(keyless.exitCode).not.toBe(0);
      expect(keyless.stderr).toContain("PLATFORM_SECRET_KEY is required");

      const ttl = await refusedStart({ HEARTBEAT_TTL_SEC: "30s" });
      expect(ttl.exitCode).not.toBe(0);
      expect(ttl.stderr).toContain(
        "HEARTBEAT_TTL_SEC must be a number of seconds above 20",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses to start on API settings that used to become defaults, naming each",
    async () => {
      const refused = await refusedStart({
        AUTH_MODE: "none",
        EGRESS_AUTHORIZER_PORT: "0",
        EGRESS_AUTHORIZER_TOKEN: "t".repeat(32),
        HEARTBEAT_TTL_SEC: "10",
        LOG_LEVEL: "inf0",
        PENDING_REQUEST_TTL_SEC: "0",
        SSE_MAX_STREAMS: "25O",
      });
      expect(refused.exitCode, refused.stderr).not.toBe(0);
      expect(refused.stderr).toContain(
        "Refusing to start: API settings are invalid",
      );
      for (const name of [
        "AUTH_MODE=none",
        "HEARTBEAT_TTL_SEC",
        "LOG_LEVEL",
        "PENDING_REQUEST_TTL_SEC",
        "SSE_MAX_STREAMS",
      ]) {
        expect(refused.stderr).toContain(name);
      }
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses to start on missing or malformed installation limits, naming each",
    async () => {
      const server = Bun.spawn(["bun", "run", "src/main.ts", "api"], {
        cwd: `${import.meta.dir}/../..`,
        env: {
          ...process.env,
          AUTH_MODE: "api-key",
          DATABASE_URL: databaseUrl,
          EXECUTION_SLOT_LIMIT: "10",
          MAX_TURN_SECONDS: "3600",
          PROVIDER_MAX_RETRIES: "",
          QUEUED_INPUT_LIMIT_PER_SESSION: "20",
          // A blank is a wrong value, not the default, and overrides whatever
          // the runner has.
          SESSION_COST_LIMIT_USD: "",
          STORAGE_LIMIT_BYTES: "-1",
          PORT: "0",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const output = Promise.all([
        new Response(server.stdout).text(),
        new Response(server.stderr).text(),
      ]).then((parts) => parts.join(""));
      const exitCode = await Promise.race([
        server.exited,
        Bun.sleep(SERVER_START_DEADLINE_MS).then(() => {
          server.kill("SIGKILL");
          return "timeout" as const;
        }),
      ]);
      const logs = await output;
      expect(exitCode, logs).not.toBe(0);
      expect(exitCode, logs).not.toBe("timeout");
      expect(logs).toContain(
        "Refusing to start: installation limits are invalid",
      );
      expect(logs).toContain(
        "SESSION_COST_LIMIT_USD must be a positive number up to 1000000",
      );
      expect(logs).toContain(
        "PROVIDER_MAX_RETRIES must be an integer from 0 to 10",
      );
      expect(logs).toContain("STORAGE_LIMIT_BYTES must be an integer");
    },
    TEST_TIMEOUT_MS,
  );
});
