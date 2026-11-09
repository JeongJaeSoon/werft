import { describe, expect, test } from "bun:test";
import {
  type ApiErrorCode,
  apiErrorResponseSchema,
  requestBodyInvalidDetailsSchema,
} from "@werft-ai/contracts";
import { MemoryLogSink, StructuredLogger } from "@werft-ai/observability";
import {
  type AuthorizationPolicy,
  createAuthorizationPolicy,
  createSessionService,
  InvalidCursorError,
  type SessionCatalog,
  type SessionControl,
  type SessionDetailRecord,
  type SessionReader,
  type SessionUnitOfWork,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerSessionRoutes } from "./sessions.ts";

const createApiApp = recordRouteErrors("routes/sessions.test.ts");

const codingProfile: SessionCatalog["profiles"][string] = {
  runtime_kind: "claude_agent_sdk",
  runtime_version: "0.3.270",
  model: "claude-sonnet-5",
  tools: ["Read", "Edit", "Bash"],
  permission_mode: "default",
  provider: {
    kind: "litellm",
    endpoint: "https://litellm.invalid",
    auth: {
      kind: "api_key",
      value: "catalog-provider-key",
      ref: { value_env: "PROVIDER_KEY" },
    },
  },
};
const catalog: SessionCatalog = {
  profiles: {
    "claude-coding-v1": codingProfile,
    "claude-review-v1": codingProfile,
  },
  repositories: {
    "sample-app": {
      url: "https://example.invalid/app.git",
      branch: "main",
      profiles: ["claude-coding-v1"],
      auth: { kind: "github_app", registered: true } as const,
    },
    // Registered, but only claude-review-v1 may run against it.
    "other-app": {
      url: "https://example.invalid/other.git",
      branch: "main",
      profiles: ["claude-review-v1"],
      auth: { kind: "github_app", registered: true } as const,
    },
  },
};

function app(
  overrides: Partial<SessionUnitOfWork & SessionReader & SessionControl> = {},
  logger?: StructuredLogger,
  authorization: AuthorizationPolicy = createAuthorizationPolicy(),
) {
  const service = createSessionService({
    limits: {
      queuedInputLimitPerSession: 1_000,
      storageLimitBytes: 1e15,
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
    },
    authorization,
    catalog,
    releases: {
      resolveRelease: async () => {
        throw new Error("not reached");
      },
      agentGitHubSettings: async () => null,
      repositoryCeiling: async () => null,
    },
    inputs: {
      acceptInputAtomic: async () => {
        throw new Error("not reached");
      },
      appendInputAtomic: async () => {
        throw new Error("not reached");
      },
      ...overrides,
    },
    controls: {
      terminateAtomic: async () => {
        throw new Error("not reached");
      },
      pauseAtomic: async () => {
        throw new Error("not reached");
      },
      closeAtomic: async () => {
        throw new Error("not reached");
      },
      decideRecoveryAtomic: async () => {
        throw new Error("not reached");
      },
      resumeAtomic: async () => {
        throw new Error("not reached");
      },
      changeProfileAtomic: async () => {
        throw new Error("not reached");
      },
      renameAtomic: async () => {
        throw new Error("not reached");
      },
      ...overrides,
    },
    reader: {
      listSessions: async () => ({ items: [], next_cursor: null }),
      countSessions: async () => {
        throw new Error("not reached");
      },
      getSession: async () => null,
      listTurns: async () => null,
      getTurn: async () => null,
      getReceipt: async () => null,
      readEvents: async () => null,
      ...overrides,
    },
  });
  return createApiApp({
    authMode: "none",
    ...(logger ? { logger } : {}),
    registerRoutes: (router) => registerSessionRoutes(router, service),
  });
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return app().request("/v1/sessions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Owner-Id": "owner-a",
      "Idempotency-Key": "key-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

const valid = {
  profile_id: "claude-coding-v1",
  repository_id: "sample-app",
  message: "hello",
};

async function errorCode(response: Response) {
  return apiErrorResponseSchema.parse(await response.json()).error.code;
}

describe("POST /v1/sessions validation", () => {
  test("requires Idempotency-Key", async () => {
    const response = await post(valid, { "Idempotency-Key": "" });
    expect(response.status).toBe(400);
    expect(await errorCode(response)).toBe("BAD_REQUEST");
  });

  test("an invalid body names each field at fault in details", async () => {
    const issuesOf = async (body: unknown) => {
      const response = await post(body);
      expect(response.status).toBe(400);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(error.message).toBe("Request body is invalid");
      return requestBodyInvalidDetailsSchema.parse(error.details).issues;
    };
    const { profile_id: _, ...withoutProfile } = valid;
    expect(await issuesOf(withoutProfile)).toEqual([
      {
        path: "profile_id",
        message: "profile_id is required without agent_release_id",
      },
    ]);
    expect(
      (await issuesOf({ ...valid, message: "", title: 7 })).map(
        (issue) => issue.path,
      ),
    ).toEqual(["title", "message"]);
  });

  test("attached_repository_ids: 400 for a repeated or invalid id; 403 without an agent release, at any count", async () => {
    for (const ids of [
      ["docs", "docs"],
      ["../docs"],
      ["origin"],
      ["docs.lock"],
      [""],
    ]) {
      const response = await post({ ...valid, attached_repository_ids: ids });
      expect(response.status).toBe(400);
      const { error } = apiErrorResponseSchema.parse(await response.json());
      expect(
        requestBodyInvalidDetailsSchema
          .parse(error.details)
          .issues.every((issue) =>
            issue.path.startsWith("attached_repository_ids"),
          ),
      ).toBe(true);
    }
    // The old cap of 32 is gone: 33 and 40 reach the release check.
    for (const count of [32, 33, 40]) {
      const unreleased = await post({
        ...valid,
        attached_repository_ids: Array.from(
          { length: count },
          (_, i) => `r-${i}`,
        ),
      });
      expect(unreleased.status).toBe(403);
      expect(await unreleased.json()).toMatchObject({
        error: {
          code: "GITHUB_REFUSED",
          details: { reason_code: "repository_not_allowed", receipt_id: null },
        },
      });
    }
  });

  test("rejects unknown profile or repository with 422", async () => {
    const unsupported = async () => ({ outcome: "unsupported" }) as const;
    const request = (body: unknown) =>
      app({ acceptInputAtomic: unsupported }).request("/v1/sessions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Owner-Id": "owner-a",
          "Idempotency-Key": "key-1",
        },
        body: JSON.stringify(body),
      });
    const response = await request({ ...valid, profile_id: "nope" });
    expect(response.status).toBe(422);
    expect(await errorCode(response)).toBe("UNSUPPORTED_CAPABILITY");
    expect((await request({ ...valid, repository_id: "nope" })).status).toBe(
      422,
    );
    // Inherited object keys are not registered profiles.
    expect((await request({ ...valid, profile_id: "toString" })).status).toBe(
      422,
    );
    // Both ids registered, but the repository does not allow the profile.
    const disallowed = await request({ ...valid, repository_id: "other-app" });
    expect(disallowed.status).toBe(422);
    expect(await errorCode(disallowed)).toBe("UNSUPPORTED_CAPABILITY");
  });

  test("a key from before workspaces names no agent release", async () => {
    const response = await post({ ...valid, agent_release_id: "rel-1" });
    expect(response.status).toBe(404);
  });

  test("replays an accepted receipt even when the catalog no longer lists the profile", async () => {
    const replayed = {
      session_id: crypto.randomUUID(),
      turn_id: "1",
      receipt_id: crypto.randomUUID(),
      receipt_status: "accepted",
      status: "queued",
    } as const;
    const response = await app({
      acceptInputAtomic: async (input) => {
        expect(input.repository).toBeNull();
        expect(input.channel).toBe("api");
        return { outcome: "replayed", response: replayed };
      },
    }).request("/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify({ ...valid, profile_id: "removed-profile" }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual(replayed);
  });

  test("maps storage connection failures to a retryable 503", async () => {
    const down = Object.assign(new Error("connection terminated"), {
      code: "57P01",
    });
    const response = await app({
      acceptInputAtomic: async () => {
        throw new Error("query failed", { cause: down });
      },
    }).request("/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify(valid),
    });
    expect(response.status).toBe(503);
    expect(
      apiErrorResponseSchema.parse(await response.json()).error,
    ).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
    const list = await app({
      listSessions: async () => {
        throw down;
      },
    }).request("/v1/sessions", { headers: { "X-Owner-Id": "owner-a" } });
    expect(list.status).toBe(503);
    const saturated = await app({
      listSessions: async () => {
        throw Object.assign(new Error("too many connections"), {
          code: "53300",
        });
      },
    }).request("/v1/sessions", { headers: { "X-Owner-Id": "owner-a" } });
    expect(saturated.status).toBe(503);
  });

  test("maps an idempotency conflict to 409 and a full queue to 429 with Retry-After", async () => {
    const refused = (outcome: "conflict" | "queue_full") =>
      app({ acceptInputAtomic: async () => ({ outcome }) }).request(
        "/v1/sessions",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Owner-Id": "owner-a",
            "Idempotency-Key": "key-1",
          },
          body: JSON.stringify(valid),
        },
      );
    const conflict = await refused("conflict");
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("IDEMPOTENCY_CONFLICT");
    const full = await refused("queue_full");
    expect(full.status).toBe(429);
    expect(full.headers.get("Retry-After")).toBe("5");
    expect(await errorCode(full)).toBe("RATE_LIMITED");
  });

  test("answers 413 for an oversized body and for an oversized message", async () => {
    const body = await post({ ...valid, message: "x".repeat(65 * 1024) });
    expect(body.status).toBe(413);
    const message = await post({ ...valid, message: "x".repeat(33 * 1024) });
    expect(message.status).toBe(413);
    expect(await errorCode(message)).toBe("PAYLOAD_TOO_LARGE");
    expect(
      (
        await post(
          { ...valid, message: "x".repeat(31 * 1024) },
          { "Idempotency-Key": "k" },
        )
      ).status,
    ).toBe(500);
  });
});

describe("GET /v1/sessions validation", () => {
  test("rejects limit above 100 and unknown status", async () => {
    const headers = { "X-Owner-Id": "owner-a" };
    expect(
      (await app().request("/v1/sessions?limit=101", { headers })).status,
    ).toBe(400);
    expect(
      (await app().request("/v1/sessions?status=bogus", { headers })).status,
    ).toBe(400);
    expect(
      (await app().request("/v1/sessions?limit=100", { headers })).status,
    ).toBe(200);
  });

  test("rejects an unknown relation and an empty or overlong q, list and counts alike", async () => {
    const headers = { "X-Owner-Id": "owner-a" };
    for (const path of ["/v1/sessions", "/v1/sessions/counts"]) {
      for (const query of [
        "relation=mine",
        "q=",
        "q=%20%20",
        `q=${"x".repeat(201)}`,
      ]) {
        expect(
          (await app().request(`${path}?${query}`, { headers })).status,
        ).toBe(400);
      }
    }
  });

  test("passes relation and q to the reader, trimmed", async () => {
    const seen: unknown[] = [];
    const counts = {
      counts: {
        queued: 0,
        running: 1,
        needs_input: 0,
        idle: 2,
        failed: 0,
        stopped: 0,
      },
      total: 3,
    };
    const reader = app({
      listSessions: async (_owner, query) => {
        seen.push(query);
        return { items: [], next_cursor: null };
      },
      countSessions: async (_owner, query) => {
        seen.push(query);
        return counts;
      },
      getSession: async () => {
        throw new Error("counts is not a session id");
      },
    });
    const headers = { "X-Owner-Id": "owner-a" };
    expect(
      (
        await reader.request("/v1/sessions?relation=shared&q=%20Fix%20", {
          headers,
        })
      ).status,
    ).toBe(200);
    const response = await reader.request(
      "/v1/sessions/counts?relation=administered&q=abc",
      { headers },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(counts);
    expect(seen).toEqual([
      { limit: 50, relation: "shared", q: "Fix" },
      { relation: "administered", q: "abc" },
    ]);
  });

  test("answers a counts read that cannot reach storage with a retryable 503", async () => {
    const response = await app({
      countSessions: async () => {
        throw Object.assign(new Error("connection terminated"), {
          code: "57P01",
        });
      },
    }).request("/v1/sessions/counts", { headers: { "X-Owner-Id": "owner-a" } });
    expect(response.status).toBe(503);
  });

  test("treats a malformed session id as not found", async () => {
    const response = await app().request("/v1/sessions/not-a-uuid", {
      headers: { "X-Owner-Id": "owner-a" },
    });
    expect(response.status).toBe(404);
  });
});

const sessionId = "019a0000-0000-7000-8000-000000000001";
const messagesPath = `/v1/sessions/${sessionId}/messages`;

function postMessage(
  body: unknown,
  overrides: Partial<SessionUnitOfWork & SessionReader> = {},
  headers: Record<string, string> = {},
  path = messagesPath,
) {
  return app(overrides).request(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Owner-Id": "owner-a",
      "Idempotency-Key": "key-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/sessions/{id}/messages validation", () => {
  const accepted = {
    turn_id: "2",
    receipt_id: crypto.randomUUID(),
    receipt_status: "accepted",
  } as const;

  test("answers 202 with the acceptance and defaults mode to enqueue", async () => {
    const response = await postMessage(
      { message: "Apply the proposed fix." },
      {
        appendInputAtomic: async (input) => {
          expect(input).toMatchObject({
            principal: { ownerId: "owner-a" },
            sessionId,
            idempotencyKey: "key-1",
            message: "Apply the proposed fix.",
            channel: "api",
          });
          return { outcome: "accepted", response: accepted };
        },
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual(accepted);
  });

  test("requires Idempotency-Key and rejects unknown mode or extra fields", async () => {
    const missing = await postMessage(
      { message: "hi" },
      {},
      { "Idempotency-Key": "" },
    );
    expect(missing.status).toBe(400);
    expect((await postMessage({ message: "hi", mode: "steer" })).status).toBe(
      400,
    );
    expect((await postMessage({ message: "hi", extra: 1 })).status).toBe(400);
    expect((await postMessage({ message: "" })).status).toBe(400);
    expect((await postMessage({ message: "x".repeat(33 * 1024) })).status).toBe(
      413,
    );
  });

  test("treats a malformed session id and an unknown session as 404", async () => {
    const malformed = await postMessage(
      { message: "hi" },
      {},
      {},
      "/v1/sessions/not-a-uuid/messages",
    );
    expect(malformed.status).toBe(404);
    const unknown = await postMessage(
      { message: "hi" },
      { appendInputAtomic: async () => ({ outcome: "not_found" }) },
    );
    expect(unknown.status).toBe(404);
    expect(await errorCode(unknown)).toBe("NOT_FOUND");
  });

  test("maps admission states to 409 codes", async () => {
    const cases = [
      ["pausing", "SESSION_PAUSED"],
      ["paused", "SESSION_PAUSED"],
      ["resuming", "SESSION_RESUMING"],
      ["stopping", "SESSION_STOPPED"],
      ["stopped", "SESSION_STOPPED"],
      ["recovery_required", "RECOVERY_REQUIRED"],
      ["closed", "SESSION_CLOSED"],
    ] as const;
    for (const [admissionState, code] of cases) {
      const response = await postMessage(
        { message: "hi" },
        {
          appendInputAtomic: async () => ({
            outcome: "rejected",
            admissionState,
          }),
        },
      );
      expect(response.status, admissionState).toBe(409);
      expect(await errorCode(response), admissionState).toBe(code);
    }
    const conflict = await postMessage(
      { message: "hi" },
      { appendInputAtomic: async () => ({ outcome: "conflict" }) },
    );
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("IDEMPOTENCY_CONFLICT");
    const full = await postMessage(
      { message: "hi" },
      { appendInputAtomic: async () => ({ outcome: "queue_full" }) },
    );
    expect(full.status).toBe(429);
    expect(full.headers.get("Retry-After")).toBe("5");
    expect(await errorCode(full)).toBe("RATE_LIMITED");
  });

  test("maps storage connection failures to a retryable 503", async () => {
    const response = await postMessage(
      { message: "hi" },
      {
        appendInputAtomic: async () => {
          throw new Error("query failed", {
            cause: Object.assign(new Error("down"), { code: "08006" }),
          });
        },
      },
    );
    expect(response.status).toBe(503);
    expect(await errorCode(response)).toBe("BACKEND_UNAVAILABLE");
  });
});

describe("GET /v1/sessions/{id}/turns validation", () => {
  const headers = { "X-Owner-Id": "owner-a" };

  test("answers 404 for a foreign session, 400 for a bad limit or cursor", async () => {
    expect(
      (await app().request(`/v1/sessions/${sessionId}/turns`, { headers }))
        .status,
    ).toBe(404);
    expect(
      (
        await app().request(`/v1/sessions/${sessionId}/turns?limit=0`, {
          headers,
        })
      ).status,
    ).toBe(400);
    const badCursor = await app({
      listTurns: async () => {
        throw new InvalidCursorError();
      },
    }).request(`/v1/sessions/${sessionId}/turns?cursor=nope`, { headers });
    expect(badCursor.status).toBe(400);
  });

  test("answers 404 for a turn the reader does not return", async () => {
    expect(
      (
        await app().request(`/v1/sessions/${sessionId}/turns/1`, {
          headers,
        })
      ).status,
    ).toBe(404);
    const foreign = await app().request(`/v1/sessions/${sessionId}/turns/1`, {
      headers: { "X-Owner-Id": "owner-b" },
    });
    expect(foreign.status).toBe(404);
    expect(
      apiErrorResponseSchema.parse(await foreign.json()).error.details,
    ).toBeNull();
  });
});

describe("POST /v1/sessions/{id}/terminate validation", () => {
  const terminatePath = `/v1/sessions/${sessionId}/terminate`;
  const terminate = (
    body: unknown,
    overrides: Partial<SessionControl> = {},
    headers: Record<string, string> = {},
    path = terminatePath,
  ) =>
    app(overrides).request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
        ...headers,
      },
      body: JSON.stringify(body),
    });

  test("answers 202 with the receipt and says external effects are not reverted", async () => {
    const receiptId = crypto.randomUUID();
    const response = await terminate(
      { expected_revision: 3, reason: "stuck" },
      {
        terminateAtomic: async (input) => {
          expect(input).toMatchObject({
            principal: { ownerId: "owner-a" },
            sessionId,
            idempotencyKey: "key-1",
            expectedRevision: 3,
            reason: "stuck",
          });
          return {
            outcome: "accepted",
            response: { receipt_id: receiptId, receipt_status: "accepted" },
          };
        },
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      receipt_id: receiptId,
      receipt_status: "accepted",
      external_effects_reverted: false,
    });
  });

  test("logs API latency with the request id and route template", async () => {
    const sink = new MemoryLogSink();
    const logger = new StructuredLogger({ sinks: [sink] });
    const receiptId = crypto.randomUUID();
    const response = await app(
      {
        terminateAtomic: async () => ({
          outcome: "accepted",
          response: { receipt_id: receiptId, receipt_status: "accepted" },
        }),
      },
      logger,
    ).request(terminatePath, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify({ expected_revision: 3 }),
    });

    expect(response.status).toBe(202);
    const record = sink.records.find(
      ({ event }) => event === "api.request.completed",
    );
    const responseRequestId = response.headers.get("X-Request-Id");
    expect(responseRequestId).not.toBeNull();
    expect(record?.request_id).toBe(responseRequestId ?? undefined);
    expect(record?.fields).toMatchObject({
      operation: "api_request",
      outcome: "succeeded",
      reason_code: "none",
      route_template: "/v1/sessions/:id/terminate",
      method: "POST",
      status: 202,
      duration_ms: expect.any(Number),
    });
    expect(JSON.stringify(record)).not.toContain(sessionId);
  });

  test("requires Idempotency-Key, expected_revision, and rejects extra fields", async () => {
    expect(
      (await terminate({ expected_revision: 1 }, {}, { "Idempotency-Key": "" }))
        .status,
    ).toBe(400);
    expect((await terminate({ reason: "no revision" })).status).toBe(400);
    expect(
      (await terminate({ expected_revision: 1, force: true })).status,
    ).toBe(400);
    expect(
      (await terminate({ expected_revision: 1, reason: "x".repeat(65 * 1024) }))
        .status,
    ).toBe(413);
  });

  test("maps revision conflict, closed session and unknown session", async () => {
    const conflict = await terminate(
      { expected_revision: 1 },
      {
        terminateAtomic: async () => ({
          outcome: "revision_conflict",
          currentRevision: 4,
        }),
      },
    );
    expect(conflict.status).toBe(409);
    expect(await errorCode(conflict)).toBe("REVISION_CONFLICT");
    const closed = await terminate(
      { expected_revision: 1 },
      {
        terminateAtomic: async () => ({
          outcome: "rejected",
          admissionState: "closed",
        }),
      },
    );
    expect(closed.status).toBe(409);
    expect(await errorCode(closed)).toBe("SESSION_CLOSED");
    const missing = await terminate(
      { expected_revision: 1 },
      { terminateAtomic: async () => ({ outcome: "not_found" }) },
    );
    expect(missing.status).toBe(404);
    const legacy = await terminate(
      { expected_revision: 1 },
      { terminateAtomic: async () => ({ outcome: "unsupported" }) },
    );
    expect(legacy.status).toBe(422);
    expect(await errorCode(legacy)).toBe("UNSUPPORTED_CAPABILITY");
    expect(
      (
        await terminate(
          { expected_revision: 1 },
          {},
          {},
          "/v1/sessions/not-a-uuid/terminate",
        )
      ).status,
    ).toBe(404);
  });
});

describe("POST /v1/sessions/{id}/recovery-decisions validation", () => {
  const path = `/v1/sessions/${sessionId}/recovery-decisions`;
  const decide = (
    body: unknown,
    overrides: Partial<SessionControl> = {},
    headers: Record<string, string> = {},
  ) =>
    app(overrides).request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
        ...headers,
      },
      body: JSON.stringify(body),
    });
  const abandon = {
    decision: "abandon",
    expected_revision: 3,
    target_turn_id: "1",
    reason: "reviewed",
  };

  test("answers 202 with the decision receipt", async () => {
    const receiptId = crypto.randomUUID();
    const response = await decide(abandon, {
      decideRecoveryAtomic: async (input) => {
        expect(input).toMatchObject({
          principal: { ownerId: "owner-a" },
          sessionId,
          idempotencyKey: "key-1",
          decision: abandon,
        });
        return {
          outcome: "accepted",
          response: { receipt_id: receiptId, receipt_status: "succeeded" },
        };
      },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      receipt_id: receiptId,
      receipt_status: "succeeded",
    });
  });

  test("confirm_completed without evidence_ref, unknown decision and extra fields are 400", async () => {
    expect(
      (
        await decide({
          decision: "confirm_completed",
          expected_revision: 1,
          target_turn_id: "1",
          reason: "r",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await decide({
          decision: "retry",
          expected_revision: 1,
          target_turn_id: "1",
          reason: "r",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await decide({
          decision: "close",
          expected_revision: 1,
          reason: "r",
          target_turn_id: "1",
        })
      ).status,
    ).toBe(400);
    expect((await decide(abandon, {}, { "Idempotency-Key": "" })).status).toBe(
      400,
    );
    expect(
      (await decide({ ...abandon, reason: "x".repeat(65 * 1024) })).status,
    ).toBe(413);
    // start_fresh names no turn: the context it gives up is all of it.
    expect(
      (
        await decide({
          decision: "start_fresh",
          expected_revision: 1,
          reason: "r",
          target_turn_id: "1",
        })
      ).status,
    ).toBe(400);
  });

  test("start_fresh and retry_restore reach the transaction as they were sent", async () => {
    for (const body of [
      {
        decision: "start_fresh" as const,
        expected_revision: 3,
        reason: "the checkpoint is gone; continue without it",
      },
      {
        decision: "retry_restore" as const,
        expected_revision: 3,
        reason: "the proxy is fixed; restore the same checkpoint",
      },
    ]) {
      const response = await decide(body, {
        decideRecoveryAtomic: async (input) => {
          expect(input.decision).toEqual(body);
          return {
            outcome: "accepted",
            response: {
              receipt_id: crypto.randomUUID(),
              receipt_status: "succeeded",
            },
          };
        },
      });
      expect(response.status).toBe(202);
    }
    // retry_restore names no turn either: it restores the same pointer.
    expect(
      (
        await decide({
          decision: "retry_restore",
          expected_revision: 1,
          reason: "r",
          target_turn_id: "1",
        })
      ).status,
    ).toBe(400);
  });

  test("maps every refusal to its status and code", async () => {
    const cases: Array<
      [
        Awaited<ReturnType<SessionControl["decideRecoveryAtomic"]>>,
        number,
        ApiErrorCode,
      ]
    > = [
      [{ outcome: "conflict" }, 409, "IDEMPOTENCY_CONFLICT"],
      [{ outcome: "not_found" }, 404, "NOT_FOUND"],
      [
        { outcome: "revision_conflict", currentRevision: 4 },
        409,
        "REVISION_CONFLICT",
      ],
      [
        { outcome: "rejected", admissionState: "closed" },
        409,
        "SESSION_CLOSED",
      ],
      [{ outcome: "execution_unconfirmed" }, 409, "RECOVERY_REQUIRED"],
      [
        { outcome: "turn_not_unknown", turnStatus: "completed" },
        409,
        "REQUEST_STALE",
      ],
      [{ outcome: "turn_not_unknown", turnStatus: null }, 404, "NOT_FOUND"],
      [{ outcome: "unsupported" }, 422, "UNSUPPORTED_CAPABILITY"],
      [{ outcome: "checkpoint_not_covering" }, 409, "CHECKPOINT_UNAVAILABLE"],
      [
        { outcome: "not_in_recovery", admissionState: "active" },
        409,
        "REQUEST_STALE",
      ],
      [{ outcome: "unknown_turn_left", turnId: "2" }, 409, "RECOVERY_REQUIRED"],
      [{ outcome: "workspace_reclaiming" }, 503, "BACKEND_UNAVAILABLE"],
      [
        { outcome: "not_restore_failed", admissionState: "recovery_required" },
        409,
        "REQUEST_STALE",
      ],
    ];
    for (const [result, status, code] of cases) {
      const response = await decide(abandon, {
        decideRecoveryAtomic: async () => result,
      });
      expect(response.status, code).toBe(status);
      expect(await errorCode(response)).toBe(code);
    }
  });

  test("a principal without sessions:recover is 403 FORBIDDEN, not 404", async () => {
    const service = createSessionService({
      limits: {
        queuedInputLimitPerSession: 1_000,
        storageLimitBytes: 1e15,
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
      },
      authorization: {
        authorize: async ({ action }) =>
          action === "session.recover"
            ? {
                outcome: "deny",
                reason_code: "role",
                effective_scopes: [],
                policy_version: "test",
                decision_id: crypto.randomUUID(),
              }
            : {
                outcome: "allow",
                reason_code: "ok",
                effective_scopes: [],
                policy_version: "test",
                decision_id: crypto.randomUUID(),
              },
      },
      catalog,
      inputs: {
        acceptInputAtomic: async () => {
          throw new Error("not reached");
        },
        appendInputAtomic: async () => {
          throw new Error("not reached");
        },
      },
      controls: {
        terminateAtomic: async () => {
          throw new Error("not reached");
        },
        pauseAtomic: async () => {
          throw new Error("not reached");
        },
        closeAtomic: async () => {
          throw new Error("not reached");
        },
        decideRecoveryAtomic: async () => {
          throw new Error("must not reach the transaction");
        },
        resumeAtomic: async () => {
          throw new Error("not reached");
        },
        changeProfileAtomic: async () => {
          throw new Error("not reached");
        },
        renameAtomic: async () => {
          throw new Error("not reached");
        },
      },
      reader: {
        listSessions: async () => ({ items: [], next_cursor: null }),
        countSessions: async () => {
          throw new Error("not reached");
        },
        getSession: async () => null,
        listTurns: async () => null,
        getTurn: async () => null,
        getReceipt: async () => null,
        readEvents: async () => null,
      },
    });
    const scoped = createApiApp({
      authMode: "none",
      registerRoutes: (router) => registerSessionRoutes(router, service),
    });
    const response = await scoped.request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify(abandon),
    });
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("FORBIDDEN");
  });
});

describe("POST /v1/sessions/{id}/resume validation", () => {
  const path = `/v1/sessions/${sessionId}/resume`;
  const resume = (body: unknown, overrides: Partial<SessionControl> = {}) =>
    app(overrides).request(path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify(body),
    });

  test("an oversized body is 413", async () => {
    expect(
      (await resume({ expected_revision: 1, pad: "x".repeat(65 * 1024) }))
        .status,
    ).toBe(413);
  });

  test("answers 202 with the receipt", async () => {
    const receiptId = crypto.randomUUID();
    const response = await resume(
      { expected_revision: 7 },
      {
        resumeAtomic: async (input) => {
          expect(input).toMatchObject({
            principal: { ownerId: "owner-a" },
            sessionId,
            idempotencyKey: "key-1",
            expectedRevision: 7,
          });
          return {
            outcome: "accepted",
            response: { receipt_id: receiptId, receipt_status: "succeeded" },
          };
        },
      },
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      receipt_id: receiptId,
      receipt_status: "succeeded",
    });
    expect((await resume({})).status).toBe(400);
    expect(
      (await resume({ expected_revision: 1, reason: "extra" })).status,
    ).toBe(400);
  });

  test("maps every refusal to its status and code", async () => {
    const cases: Array<
      [
        Awaited<ReturnType<SessionControl["resumeAtomic"]>>,
        number,
        ApiErrorCode,
      ]
    > = [
      [
        { outcome: "recovery_required", unconfirmedTurnId: "1" },
        409,
        "RECOVERY_REQUIRED",
      ],
      [
        { outcome: "recovery_required", unconfirmedTurnId: null },
        409,
        "RECOVERY_REQUIRED",
      ],
      [{ outcome: "checkpoint_unavailable" }, 409, "CHECKPOINT_UNAVAILABLE"],
      [
        { outcome: "rejected", admissionState: "closed" },
        409,
        "SESSION_CLOSED",
      ],
      [{ outcome: "rejected", admissionState: "active" }, 409, "REQUEST_STALE"],
      [{ outcome: "pause_committing" }, 409, "PAUSE_COMMITTING"],
      [
        { outcome: "rejected", admissionState: "resuming" },
        409,
        "SESSION_RESUMING",
      ],
      [{ outcome: "unsupported" }, 422, "UNSUPPORTED_CAPABILITY"],
      [{ outcome: "workspace_reclaiming" }, 503, "BACKEND_UNAVAILABLE"],
      [{ outcome: "not_found" }, 404, "NOT_FOUND"],
      [
        { outcome: "revision_conflict", currentRevision: 2 },
        409,
        "REVISION_CONFLICT",
      ],
    ];
    for (const [result, status, code] of cases) {
      const response = await resume(
        { expected_revision: 1 },
        { resumeAtomic: async () => result },
      );
      expect(response.status, code).toBe(status);
      expect(await errorCode(response)).toBe(code);
    }
  });

  test("a workspace being reclaimed is worth retrying; the other refusals are not", async () => {
    const refused = async (
      result: Awaited<ReturnType<SessionControl["resumeAtomic"]>>,
    ) => {
      const response = await resume(
        { expected_revision: 1 },
        { resumeAtomic: async () => result },
      );
      return apiErrorResponseSchema.parse(await response.json()).error;
    };

    expect(await refused({ outcome: "workspace_reclaiming" })).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
    expect(await refused({ outcome: "checkpoint_unavailable" })).toMatchObject({
      code: "CHECKPOINT_UNAVAILABLE",
      retryable: false,
    });
  });
});

describe("session titles (94S-804)", () => {
  const path = `/v1/sessions/${sessionId}`;
  const record: SessionDetailRecord = {
    id: sessionId,
    title: "Renamed",
    agent: null,
    created_by: null,
    channel: null,
    slack_permalink: null,
    revision: 2,
    admission_state: "active",
    status: "idle",
    repository_id: "sample-app",
    repository: { id: "sample-app", full_name: "sample-app", branch: "main" },
    current_turn_id: null,
    queued_turn_count: 0,
    last_event_at: null,
    created_at: "2026-10-23T00:00:00.000Z",
    updated_at: "2026-10-23T00:00:00.000Z",
    execution: null,
    checkpoint_revision: null,
    pending_request_count: 0,
    attention: null,
    durability: {
      last_transcript_persisted_at: null,
      checkpoint_committed_at: null,
      checkpoint_revision: null,
      last_completed_turn_id: null,
      last_checkpointed_turn_id: null,
      checkpoint_pending_reason: null,
      checkpoint_fallback_revision: null,
      context_reset_turn_id: null,
    },
    profile_id: "claude-coding-v1",
    model: "claude-sonnet-5",
    cost_usd: 0,
    provider_tokens: 0,
    repo_url: "https://example.invalid/app.git",
    branch: "main",
    repository_mode: "repository",
    github_policy_source: "release",
    profile_fingerprint: null,
    auto_model_migration: true,
  };
  const accepted = {
    session_id: sessionId,
    turn_id: "1",
    receipt_id: crypto.randomUUID(),
    receipt_status: "accepted",
    status: "queued",
  } as const;

  async function createdTitle(body: unknown) {
    let title: string | null | undefined;
    const response = await app({
      acceptInputAtomic: async (input) => {
        title = input.title;
        return { outcome: "accepted", response: accepted };
      },
    }).request("/v1/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Owner-Id": "owner-a",
        "Idempotency-Key": "key-1",
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(201);
    return title;
  }

  test("create keeps a given title, whitespace collapsed", async () => {
    expect(await createdTitle({ ...valid, title: "  My\n  session " })).toBe(
      "My session",
    );
  });

  test("create without a title derives it from the message", async () => {
    expect(
      await createdTitle({ ...valid, message: "Fix the\n\nflaky test" }),
    ).toBe("Fix the flaky test");
    expect(await createdTitle({ ...valid, message: " \n " })).toBeNull();
  });

  test("create refuses an empty or overlong title", async () => {
    expect((await post({ ...valid, title: "  " })).status).toBe(400);
    expect((await post({ ...valid, title: "x".repeat(81) })).status).toBe(400);
  });

  function patch(
    body: unknown,
    overrides: Partial<SessionUnitOfWork & SessionReader & SessionControl>,
    authorization?: AuthorizationPolicy,
  ) {
    return app(overrides, undefined, authorization).request(path, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Owner-Id": "owner-a" },
      body: JSON.stringify(body),
    });
  }

  test("rename stores the collapsed title and answers the detail", async () => {
    let stored: string | undefined;
    const response = await patch(
      { title: " Renamed\n" },
      {
        renameAtomic: async (input) => {
          stored = input.title;
          return { outcome: "renamed", changed: true };
        },
        getSession: async () => record,
      },
    );
    expect(response.status).toBe(200);
    expect(stored).toBe("Renamed");
    expect(await response.json()).toMatchObject({
      id: sessionId,
      title: "Renamed",
    });
  });

  test("rename refuses a bad body with 400 and an oversized one with 413", async () => {
    const untouched = {
      renameAtomic: async () => {
        throw new Error("not reached");
      },
    };
    for (const body of [
      {},
      { title: "" },
      { title: null },
      { title: "a", x: 1 },
    ]) {
      const response = await patch(body, untouched);
      expect(response.status).toBe(400);
    }
    const large = await patch({ title: "x".repeat(65 * 1024) }, untouched);
    expect(large.status).toBe(413);
  });

  test("rename of an unknown session is 404", async () => {
    const response = await patch(
      { title: "T" },
      { renameAtomic: async () => ({ outcome: "not_found" }) },
    );
    expect(response.status).toBe(404);
    expect(await errorCode(response)).toBe("NOT_FOUND");
  });

  test("rename refused by the policy is 403 and never reaches the store", async () => {
    const response = await patch(
      { title: "T" },
      {
        renameAtomic: async () => {
          throw new Error("not reached");
        },
      },
      {
        authorize: async ({ action }) => ({
          outcome: action === "session.rename" ? "deny" : "allow",
          reason_code: action === "session.rename" ? "role" : "ok",
          effective_scopes: ["sessions:write"],
          policy_version: "test",
          decision_id: crypto.randomUUID(),
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("FORBIDDEN");
  });

  test("rename needs the read it answers with: without it the store is never reached", async () => {
    const response = await patch(
      { title: "T" },
      {
        renameAtomic: async () => {
          throw new Error("not reached");
        },
      },
      {
        authorize: async ({ action }) => ({
          outcome: action === "session.read" ? "deny" : "allow",
          reason_code: action === "session.read" ? "role" : "ok",
          effective_scopes: ["sessions:write"],
          policy_version: "test",
          decision_id: crypto.randomUUID(),
        }),
      },
    );
    expect(response.status).toBe(403);
  });

  test("rename by a member offboarded since the check is 403", async () => {
    const response = await patch(
      { title: "T" },
      { renameAtomic: async () => ({ outcome: "actor_inactive" }) },
    );
    expect(response.status).toBe(403);
    expect(await errorCode(response)).toBe("FORBIDDEN");
  });

  test("rename maps a storage connection failure to 503", async () => {
    const response = await patch(
      { title: "T" },
      {
        renameAtomic: async () => {
          throw Object.assign(new Error("connection terminated"), {
            code: "57P01",
          });
        },
      },
    );
    expect(response.status).toBe(503);
  });
});
