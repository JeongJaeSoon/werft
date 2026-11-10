import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import {
  apiErrorResponseSchema,
  appendEventsResponseSchema,
  type BootstrapClaimResponse,
  bootstrapClaimResponseSchema,
  checkpointRequestResponseSchema,
  finalizeResponseSchema,
  heartbeatResponseSchema,
  nextInputResponseSchema,
  releaseResponseSchema,
  restorePlanResponseSchema,
  type SessionExtension,
} from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
  events,
  sessions,
  turns,
} from "@werft-ai/db";
import {
  insertUnreservedLaunch,
  launchSession,
} from "@werft-ai/db/testing/launches";
import { TEST_MODEL } from "@werft-ai/db/testing/spec-pins";
import { formatTraceparent, turnTraceId } from "@werft-ai/observability";
import { createOtelTracer } from "@werft-ai/observability/otel";
import { acceptAllCheckpoints, createWorkerGateway } from "@werft-ai/platform";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { testCatalog } from "../../testing/catalog.ts";
import { releaseIn, TEST_OWNER } from "../../testing/releases.ts";
import { createApiApp } from "../app.ts";
import { RequestTracing } from "../request-tracing.ts";
import { registerWorkerRoutes } from "./worker.ts";

// Every call in a test that expects success has to land inside one lease on
// a loaded runner; only the expiry test waits it out.
const LEASE_TTL_MS = 2_000;

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let app: ReturnType<typeof createApiApp>;
let gateway: ReturnType<typeof createWorkerGateway>;
let clock: Date;
const archives = new Map<string, Uint8Array>();

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  clock = new Date("2026-09-22T00:00:00.000Z");
  archives.clear();
  gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    extensions: {
      archive: async (workspaceId, digest) =>
        archives.get(`${workspaceId}/${digest}`) ?? null,
    },
    catalog: testCatalog({
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
          auth: { kind: "github_app", registered: true } as const,
        },
      },
    }),
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: LEASE_TTL_MS,
      now: () => clock,
      sleep: async () => {},
    },
  });
  app = createApiApp({
    authMode: "api-key",
    registerInternalRoutes: (router) => registerWorkerRoutes(router, gateway),
  });
});

afterEach(async () => {
  await client.close();
});

async function seedSession(extensions?: SessionExtension[]) {
  const result = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: { ownerId: TEST_OWNER },
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "hash",
    agentReleaseId: await releaseIn(db),
    model: TEST_MODEL,
    repository: {
      id: "sample-app",
      url: "https://example.invalid/app.git",
      branch: "main",
    },
    message: "hello worker",
    ...(extensions === undefined ? {} : { extensions }),
  });
  if (result.outcome !== "accepted") throw new Error(result.outcome);
  return result.response;
}

function post(path: string, token: string | null, body: unknown) {
  return app.request(`/internal/worker/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function errorOf(response: Response) {
  const body = apiErrorResponseSchema.parse(await response.json());
  return { status: response.status, code: body.error.code };
}

function scope(claimed: BootstrapClaimResponse, turnId: string | null = null) {
  return {
    session_id: claimed.session_id,
    turn_id: turnId,
    attempt_id: claimed.attempt_id,
    lease_epoch: claimed.lease_epoch,
    execution_generation: claimed.execution_generation,
    auth_revision: claimed.auth_revision,
  };
}

async function claimed(sessionId: string) {
  const launch = await launchSession(db, { sessionId });
  const response = await post("bootstrap-claim", launch.nonce, {
    execution_id: launch.executionId,
    execution_generation: launch.generation,
    credential: { kind: "launch_nonce", nonce: launch.nonce },
  });
  expect(response.status).toBe(200);
  return {
    launch,
    nonce: launch.nonce,
    binding: bootstrapClaimResponseSchema.parse(await response.json()),
  };
}

describe("/internal/worker", () => {
  test("is not behind the /v1 API-key middleware: a missing or unknown token is 401 from the gateway", async () => {
    await seedSession();
    expect(await errorOf(await post("heartbeat", null, {}))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    expect(await errorOf(await post("heartbeat", "wsc_nope", {}))).toEqual({
      status: 401,
      code: "UNAUTHORIZED",
    });
    // A /v1 API key is not a worker token either.
    const v1 = await app.request("/v1/sessions", {
      headers: { authorization: "Bearer csp_whatever" },
    });
    expect(v1.status).toBe(401);
  });

  test("a token the database cannot be asked about yet is a retryable 503, never 401", async () => {
    // What an API that restarted ahead of its database meets: PostgreSQL
    // answering that it is still starting up.
    const work = createPostgresWorkerUnitOfWork(db);
    const starting = createApiApp({
      authMode: "api-key",
      registerInternalRoutes: (router) =>
        registerWorkerRoutes(
          router,
          createWorkerGateway({
            work: {
              ...work,
              resolveCredential: async () => {
                throw Object.assign(
                  new Error("the database system is starting up"),
                  { code: "57P03" },
                );
              },
            },
            catalog: { connections: {}, repositories: {} },
            checkpoints: acceptAllCheckpoints,
            options: {
              sessionCostLimitUsd: 1_000,
              sessionTokenLimit: null,
              leaseTtlMs: LEASE_TTL_MS,
            },
          }),
        ),
    });
    const response = await starting.request("/internal/worker/heartbeat", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer wsc_valid",
      },
      body: "{}",
    });

    expect(response.status).toBe(503);
    expect(
      apiErrorResponseSchema.parse(await response.json()).error.retryable,
    ).toBe(true);
  });

  test.each([
    ["40P01", "deadlock detected"],
    ["40001", "could not serialize access due to concurrent update"],
    ["55P03", "canceling statement due to lock timeout"],
  ])(
    "a transaction rolled back with %s is a retryable 503 with Retry-After, not a lost lease",
    async (code, text) => {
      const { binding } = await claimed((await seedSession()).session_id);
      const work = createPostgresWorkerUnitOfWork(db);
      const conflicted = createApiApp({
        authMode: "api-key",
        registerInternalRoutes: (router) =>
          registerWorkerRoutes(
            router,
            createWorkerGateway({
              work: {
                ...work,
                heartbeatAtomic: async () => {
                  throw new Error("Failed query", {
                    cause: Object.assign(new Error(text), { code }),
                  });
                },
              },
              catalog: { connections: {}, repositories: {} },
              checkpoints: acceptAllCheckpoints,
              options: {
                sessionCostLimitUsd: 1_000,
                sessionTokenLimit: null,
                leaseTtlMs: LEASE_TTL_MS,
              },
            }),
          ),
      });
      const response = await conflicted.request("/internal/worker/heartbeat", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${binding.session_credential}`,
        },
        body: JSON.stringify({ ...scope(binding), attempt_state: "running" }),
      });

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("1");
      expect(
        apiErrorResponseSchema.parse(await response.json()).error,
      ).toMatchObject({ code: "BACKEND_UNAVAILABLE", retryable: true });
    },
  );

  test("the bootstrap token can only call bootstrap-claim", async () => {
    const { launch, nonce, binding } = await claimed(
      (await seedSession()).session_id,
    );
    expect(
      await errorOf(await post("next-input", nonce, scope(binding))),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(
      await errorOf(
        await post("heartbeat", nonce, {
          ...scope(binding),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    // The session token, conversely, cannot re-enter bootstrap.
    expect(
      await errorOf(
        await post("bootstrap-claim", binding.session_credential, {
          execution_id: launch.executionId,
          execution_generation: launch.generation,
          credential: { kind: "launch_nonce", nonce },
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
  });

  test("bootstrap-claim refuses a bearer nonce other than the one it claims with", async () => {
    const first = await claimed((await seedSession()).session_id);
    expect(
      (
        await post("release", first.binding.session_credential, {
          ...scope(first.binding),
          reason: "idle_timeout",
        })
      ).status,
    ).toBe(200);
    const second = await launchSession(db, {
      sessionId: (await seedSession()).session_id,
    });
    const claim = {
      execution_id: second.executionId,
      execution_generation: second.generation,
      credential: { kind: "launch_nonce", nonce: second.nonce },
    };
    expect(
      await errorOf(await post("bootstrap-claim", first.nonce, claim)),
    ).toEqual({ status: 401, code: "UNAUTHORIZED" });
    // The refusal consumed nothing: the launch still claims with its own.
    expect((await post("bootstrap-claim", second.nonce, claim)).status).toBe(
      200,
    );
  });

  test("a session token cannot act for a binding it does not own", async () => {
    const seeded = await seedSession();
    const { binding } = await claimed(seeded.session_id);
    const forged = { ...scope(binding), attempt_id: "att_other" };
    expect(
      await errorOf(
        await post("heartbeat", binding.session_credential, {
          ...forged,
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(seeded.session_id).toBe(binding.session_id);
  });

  test("bootstrap-claim answers 404 when the partition has no waiting session", async () => {
    const launch = await insertUnreservedLaunch(db, { partition: "default" });
    const response = await post("bootstrap-claim", launch.nonce, {
      execution_id: launch.executionId,
      execution_generation: launch.generation,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    });
    expect(await errorOf(response)).toEqual({
      status: 404,
      code: "NOT_FOUND",
    });
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  test("runs one attempt end to end over HTTP", async () => {
    const seeded = await seedSession();
    const { binding } = await claimed(seeded.session_id);
    const token = binding.session_credential;
    expect(binding.workspace.repository).toEqual({
      id: "sample-app",
      url: "https://example.invalid/app.git",
      branch: "main",
      access: { kind: "egress_token", token: expect.stringMatching(/^wer_/) },
    });
    // The provider key never crosses this route; the worker holds
    // a token only the egress proxy's authorizer can turn into it.
    expect(binding.runtime_config.provider.auth).toEqual({
      kind: "egress_token",
      token: expect.stringMatching(/^wep_/),
    });
    expect(JSON.stringify(binding)).not.toContain("catalog-provider-key");
    // The seeded session's owner rides the claim as the checkpoint principal.
    expect(binding.principal).toEqual({ owner_scope: TEST_OWNER });

    const next = nextInputResponseSchema.parse(
      await (await post("next-input", token, scope(binding))).json(),
    );
    expect(next.input?.turn_id).toBe("1");
    expect(next.input?.message).toBe("hello worker");
    const [turn] = await db
      .select({ deliveryStartedAt: turns.deliveryStartedAt })
      .from(turns)
      .where(eq(turns.sessionId, seeded.session_id));
    expect(turn?.deliveryStartedAt?.toISOString()).toBe(clock.toISOString());

    clock = new Date(clock.getTime() + 400);
    // PGlite runs in this process, so its clock is Date.now().
    const floor = Date.now();
    const beat = heartbeatResponseSchema.parse(
      await (
        await post("heartbeat", token, {
          ...scope(binding),
          attempt_state: "running",
        })
      ).json(),
    );
    const extended = new Date(beat.lease_expires_at).getTime();
    expect(extended).toBeGreaterThanOrEqual(floor + LEASE_TTL_MS);
    expect(extended).toBeLessThanOrEqual(Date.now() + LEASE_TTL_MS);

    const batch = {
      ...scope(binding, "1"),
      batch_key: "b-1",
      events: [
        {
          event: "assistant",
          data: { type: "assistant", message: { text: "hi" } },
          source_sequence: 1,
          occurred_at: clock.toISOString(),
        },
        {
          event: "result",
          data: { type: "result", subtype: "success", session_id: "sdk-1" },
          source_sequence: 2,
          occurred_at: clock.toISOString(),
        },
      ],
    };
    const appended = appendEventsResponseSchema.parse(
      await (await post("append-events", token, batch)).json(),
    );
    expect(appended.accepted_through).toBe(2);
    const resent = await post("append-events", token, batch);
    expect(resent.status).toBe(200);
    expect(appendEventsResponseSchema.parse(await resent.json())).toEqual(
      appended,
    );
    const [stored] = await db
      .select({ n: count() })
      .from(events)
      .where(
        and(
          eq(events.sessionId, seeded.session_id),
          // The worker's own rows; the delivery's status is the server's.
          isNotNull(events.sourceSequence),
        ),
      );
    expect(stored?.n).toBe(2);

    const finalized = finalizeResponseSchema.parse(
      await (
        await post("finalize", token, {
          ...scope(binding, "1"),
          turn_id: "1",
          finalize_key: "fin-1",
          final_source_sequence: 2,
          terminal: {
            status: "completed",
            reason: null,
            result: { ok: true },
            usage: null,
          },
          checkpoint: {
            revision: 0,
            manifest_ref: "s3://b/m.json",
            manifest_sha256: "f".repeat(64),
          },
        })
      ).json(),
    );
    expect(finalized).toEqual({
      turn_id: "1",
      status: "completed",
      checkpoint_revision: 0,
    });
    const [row] = await db
      .select({
        status: sessions.status,
        checkpointRevision: sessions.checkpointRevision,
      })
      .from(sessions)
      .where(eq(sessions.id, seeded.session_id));
    expect(row).toEqual({ status: "idle", checkpointRevision: 0 });

    const released = releaseResponseSchema.parse(
      await (
        await post("release", token, {
          ...scope(binding),
          reason: "idle_timeout",
        })
      ).json(),
    );
    expect(released).toEqual({ released: true });
    // The token died with the attempt.
    expect(
      await errorOf(
        await post("heartbeat", token, {
          ...scope(binding),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 401, code: "UNAUTHORIZED" });
  });

  test("heartbeat after the TTL is 409 LEASE_EXPIRED", async () => {
    const { binding } = await claimed((await seedSession()).session_id);
    // The lease runs on the database clock, so only real time ends it.
    await new Promise((resolve) => setTimeout(resolve, LEASE_TTL_MS + 50));
    expect(
      await errorOf(
        await post("heartbeat", binding.session_credential, {
          ...scope(binding),
          attempt_state: "running",
        }),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
  });

  test("a stale epoch is 409 STALE_EPOCH", async () => {
    const { binding } = await claimed((await seedSession()).session_id);
    expect(
      await errorOf(
        await post("append-events", binding.session_credential, {
          ...scope(binding),
          lease_epoch: binding.lease_epoch - 1,
          batch_key: "b",
          events: [
            {
              event: "status",
              data: { phase: "running" },
              source_sequence: 1,
              occurred_at: clock.toISOString(),
            },
          ],
        }),
      ),
    ).toEqual({ status: 409, code: "STALE_EPOCH" });
  });

  test("rejects a malformed body with 400 before touching the gateway", async () => {
    const { binding } = await claimed((await seedSession()).session_id);
    expect(
      await errorOf(
        await post("heartbeat", binding.session_credential, {
          ...scope(binding),
          attempt_state: "running",
          extra: true,
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    // These columns are int4, so a larger number is a bad request rather
    // than a failed insert surfacing as 500.
    expect(
      await errorOf(
        await post("append-events", binding.session_credential, {
          ...scope(binding),
          turn_id: "1",
          batch_key: "b",
          events: [
            {
              event: "status",
              data: { phase: "running" },
              source_sequence: 2_147_483_648,
              occurred_at: clock.toISOString(),
            },
          ],
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    expect(
      await errorOf(
        await post("finalize", binding.session_credential, {
          ...scope(binding),
          turn_id: "1",
          finalize_key: "f",
          final_source_sequence: 0,
          terminal: {
            status: "completed",
            reason: null,
            result: null,
            usage: null,
          },
          checkpoint: {
            revision: 2_147_483_648,
            manifest_ref: "s3://bucket/m.json",
            manifest_sha256: "a".repeat(64),
          },
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
  });

  test("checkpoint-request and restore-plan are fenced session-token calls answered by the checkpoint protocol", async () => {
    const { binding, nonce } = await claimed((await seedSession()).session_id);
    const token = binding.session_credential;
    const protocolCalls: unknown[] = [];
    const withProtocol = createApiApp({
      authMode: "api-key",
      registerInternalRoutes: (router) =>
        registerWorkerRoutes(
          router,
          createWorkerGateway({
            work: createPostgresWorkerUnitOfWork(db),
            catalog: { connections: {}, repositories: {} },
            checkpoints: acceptAllCheckpoints,
            checkpointProtocol: {
              async requestCheckpoint(input) {
                protocolCalls.push(input);
                const revision = (input.pointer?.revision ?? -1) + 1;
                return {
                  status: "ready",
                  request: {
                    manifestRef: `sessions/${input.sessionId}/checkpoints/${String(revision).padStart(10, "0")}/${input.attemptId}/manifest.json`,
                    revision,
                    sessionId: input.sessionId,
                  },
                };
              },
              async getRestorePlan() {
                return { status: "none" };
              },
            },
            options: {
              sessionCostLimitUsd: 1_000,
              sessionTokenLimit: null,
              leaseTtlMs: LEASE_TTL_MS,
              now: () => clock,
            },
          }),
        ),
    });
    const post = (path: string, token: string | null, body: unknown) =>
      withProtocol.request(`/internal/worker/${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
    expect(
      checkpointRequestResponseSchema.parse(
        await (
          await post("checkpoint-request", token, {
            ...scope(binding),
            preparation: { status: "ready" },
          })
        ).json(),
      ),
    ).toEqual({
      status: "ready",
      revision: 0,
      manifest_ref: `sessions/${binding.session_id}/checkpoints/0000000000/${binding.attempt_id}/manifest.json`,
    });
    expect(protocolCalls.at(-1)).toMatchObject({
      attemptId: binding.attempt_id,
      sessionId: binding.session_id,
      pointer: null,
    });
    expect(
      checkpointRequestResponseSchema.parse(
        await (
          await post("checkpoint-request", token, {
            ...scope(binding),
            preparation: {
              status: "rejected",
              reason: "turn_in_flight",
              detail: "input pending",
            },
          })
        ).json(),
      ),
    ).toEqual({
      status: "blocked",
      reason: "turn_in_flight",
      detail: "input pending",
    });
    expect(
      restorePlanResponseSchema.parse(
        await (
          await post("restore-plan", token, {
            ...scope(binding),
            runtime: {
              engine: "claude",
              sdk_version: "0.3.270",
              cli_version: "2.1.270",
              profile_sha256: "c".repeat(64),
            },
          })
        ).json(),
      ),
    ).toEqual({ status: "none" });
    // The bootstrap token cannot ask; a malformed preparation never reaches
    // the gateway.
    expect(
      await errorOf(
        await post("checkpoint-request", nonce, {
          ...scope(binding),
          preparation: { status: "ready" },
        }),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(
      await errorOf(
        await post("checkpoint-request", token, {
          ...scope(binding),
          preparation: { status: "rejected", reason: "disk_full", detail: "x" },
        }),
      ),
    ).toEqual({ status: 400, code: "BAD_REQUEST" });
    // The heartbeat carries the transcript report through to the row.
    const beat = await post("heartbeat", token, {
      ...scope(binding),
      attempt_state: "running",
      transcript: {
        persisted_at: "2026-09-22T00:00:01.000Z",
        mirror_error: null,
      },
    });
    expect(beat.status).toBe(200);
    const [row] = await db
      .select({ persistedAt: sessions.lastTranscriptPersistedAt })
      .from(sessions)
      .where(eq(sessions.id, binding.session_id));
    expect(row?.persistedAt?.toISOString()).toBe("2026-09-22T00:00:01.000Z");
  });

  test("without an object store the checkpoint protocol is 409 CHECKPOINT_UNAVAILABLE", async () => {
    const { binding } = await claimed((await seedSession()).session_id);
    const response = await post(
      "checkpoint-request",
      binding.session_credential,
      {
        ...scope(binding),
        preparation: { status: "ready" },
      },
    );
    expect(await errorOf(response)).toEqual({
      status: 409,
      code: "CHECKPOINT_UNAVAILABLE",
    });
  });
});

describe("/internal/worker bundles", () => {
  const LINT = {
    name: "lint",
    digest: "ab".repeat(32),
    scope: "agent",
  } as const;
  const OTHER = {
    name: "docs",
    digest: "cd".repeat(32),
    scope: "workspace",
  } as const;
  const pinned = (
    ...bundles: (typeof LINT | typeof OTHER)[]
  ): SessionExtension[] =>
    bundles.map((b, i) => ({
      bundle_id: `019a0000-0000-7000-8000-0000000e000${i + 1}`,
      ...b,
    }));
  const bytes = new Uint8Array([1, 2, 3, 4]);

  function get(attemptId: string, digest: string, token: string | null) {
    return app.request(
      `/internal/worker/attempts/${attemptId}/extensions/${digest}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {} },
    );
  }

  test("a session without bundles claims without the field", async () => {
    const { binding } = await claimed((await seedSession()).session_id);
    expect(Object.keys(binding.runtime_config)).not.toContain("extensions");
  });

  test("a session accepted with bundles claims them, a replayed claim names the same list, and the holder fetches the bytes", async () => {
    const seeded = await seedSession(pinned(LINT));
    const { binding, launch, nonce } = await claimed(seeded.session_id);
    expect(binding.runtime_config.extensions).toEqual([LINT]);
    const replay = await post("bootstrap-claim", nonce, {
      execution_id: launch.executionId,
      execution_generation: launch.generation,
      credential: { kind: "launch_nonce", nonce },
    });
    const again = bootstrapClaimResponseSchema.parse(await replay.json());
    expect(again.runtime_config.extensions).toEqual([LINT]);
    archives.set(`${TEST_OWNER}/${LINT.digest}`, bytes);
    const served = await get(
      binding.attempt_id,
      LINT.digest,
      again.session_credential,
    );
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("application/x-tar");
    expect(served.headers.get("x-bundle-digest")).toBe(LINT.digest);
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(bytes);
  });

  test("a digest the session's row did not pin is 404, even when the workspace holds it", async () => {
    const { binding } = await claimed(
      (await seedSession(pinned(LINT))).session_id,
    );
    archives.set(`${TEST_OWNER}/${OTHER.digest}`, bytes);
    const response = await get(
      binding.attempt_id,
      OTHER.digest,
      binding.session_credential,
    );
    expect(await errorOf(response)).toEqual({ status: 404, code: "NOT_FOUND" });
  });

  test("another session's token, another attempt's path, no token and an unknown token are refused", async () => {
    const mine = await claimed((await seedSession(pinned(LINT))).session_id);
    const theirs = await claimed((await seedSession(pinned(LINT))).session_id);
    archives.set(`${TEST_OWNER}/${LINT.digest}`, bytes);
    expect(
      await errorOf(
        await get(
          mine.binding.attempt_id,
          LINT.digest,
          theirs.binding.session_credential,
        ),
      ),
    ).toEqual({ status: 403, code: "FORBIDDEN" });
    expect(
      (await errorOf(await get(mine.binding.attempt_id, LINT.digest, null)))
        .status,
    ).toBe(401);
    expect(
      (
        await errorOf(
          await get(mine.binding.attempt_id, LINT.digest, "wsc_nope"),
        )
      ).status,
    ).toBe(401);
  });

  test("a token whose lease ran out gets 409 LEASE_EXPIRED", async () => {
    const { binding } = await claimed(
      (await seedSession(pinned(LINT))).session_id,
    );
    archives.set(`${TEST_OWNER}/${LINT.digest}`, bytes);
    await new Promise((resolve) => setTimeout(resolve, LEASE_TTL_MS + 50));
    expect(
      await errorOf(
        await get(binding.attempt_id, LINT.digest, binding.session_credential),
      ),
    ).toEqual({ status: 409, code: "LEASE_EXPIRED" });
  });

  // 94S-731: a gateway call joins a turn trace only when its own session acts.
  test("a call joins its turn's trace only for the token's own session", async () => {
    const exported: string[] = [];
    const tracer = createOtelTracer({
      serviceName: "werft-api-test",
      sampler: { kind: "always_on", ratio: 1 },
      headers: {},
      tenantHeaders: () => ({}),
      exporter: {
        export(batch, done) {
          for (const span of batch) exported.push(span.spanContext().traceId);
          done({ code: 0 });
        },
        shutdown: async () => {},
      },
    });
    const traced = (using: typeof tracer) =>
      createApiApp({
        authMode: "api-key",
        tracer: using,
        registerInternalRoutes: (router) =>
          registerWorkerRoutes(router, gateway, new RequestTracing(using)),
      });
    app = traced(tracer);
    const { binding } = await claimed((await seedSession()).session_id);
    const call = (sessionId: string, traceparentOf: string) =>
      app.request("/internal/worker/next-input", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${binding.session_credential}`,
          traceparent: formatTraceparent({
            traceId: turnTraceId(traceparentOf, 1),
            spanId: "00f067aa0ba902b7",
            sampled: true,
          }),
        },
        body: JSON.stringify({
          ...scope(binding, "1"),
          session_id: sessionId,
          wait_ms: 0,
        }),
      });

    // Another session's turn trace, named in the body: no span.
    const other = crypto.randomUUID();
    await call(other, other);
    await tracer.shutdown();
    expect(exported).toEqual([]);

    // The same call for the token's own session is traced.
    const own = createOtelTracer({
      serviceName: "werft-api-test",
      sampler: { kind: "always_on", ratio: 1 },
      headers: {},
      tenantHeaders: () => ({}),
      exporter: {
        export(batch, done) {
          for (const span of batch) exported.push(span.spanContext().traceId);
          done({ code: 0 });
        },
        shutdown: async () => {},
      },
    });
    app = traced(own);
    await call(binding.session_id, binding.session_id);
    await own.shutdown();
    expect(exported).toEqual([turnTraceId(binding.session_id, 1)]);
  });
});
