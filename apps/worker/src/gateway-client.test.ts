import { describe, expect, test } from "bun:test";
import {
  isOwnershipLost,
  isRetryable,
  WorkerGatewayRequestError,
} from "@werft-ai/runtime-core";

import { HttpWorkerGatewayClient } from "./gateway-client.ts";
import { Heartbeat } from "./heartbeat.ts";

type Recorded = { body: unknown; headers: Record<string, string>; url: string };

function client(
  respond: (recorded: Recorded) => Response | Promise<Response>,
  recorded: Recorded[] = [],
) {
  return {
    recorded,
    gateway: new HttpWorkerGatewayClient({
      baseUrl: "http://gateway.internal/",
      credential: "wln_launch",
      requestTimeoutMs: 1_000,
      fetch: async (input, init) => {
        const entry: Recorded = {
          body: JSON.parse(String(init?.body ?? "null")),
          headers: Object.fromEntries(
            Object.entries((init?.headers ?? {}) as Record<string, string>),
          ),
          url: String(input),
        };
        recorded.push(entry);
        return respond(entry);
      },
    }),
  };
}

function ok(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function apiError(status: number, code: string, retryable = false): Response {
  return new Response(
    JSON.stringify({
      error: {
        code,
        message: `${code} from the gateway`,
        retryable,
        request_id: "req_1",
        details: null,
      },
    }),
    { status, headers: { "Content-Type": "application/json" } },
  );
}

const scope = {
  session_id: "11111111-1111-4111-8111-111111111111",
  turn_id: null,
  attempt_id: "att_1",
  lease_epoch: 1,
  execution_generation: 2,
  auth_revision: 0,
};

describe("HttpWorkerGatewayClient", () => {
  test("posts to the worker protocol path with the current credential", async () => {
    const { gateway, recorded } = client(() =>
      ok({
        ...scope,
        session_credential: "wsc_session",
        lease_expires_at: new Date().toISOString(),
        lease_remaining_ms: 30_000,
        runtime: {
          kind: "claude_agent_sdk",
          version: "0.3.270",
          connection_id: "c",
        },
        spec_digest: `sha256:${"0".repeat(64)}`,
        runtime_config: {
          model: "claude-sonnet-4-5",
          tools: [],
          permission_mode: "default",
          provider: {
            kind: "litellm",
            endpoint: "http://litellm:4000",
            auth: { kind: "egress_token", token: "placeholder" },
          },
        },
        workspace: {
          repository: {
            id: "sample-app",
            url: "https://git.example.test/sample.git",
            branch: "main",
          },
        },
        object_store: {
          access: { kind: "egress_token", token: "weo_object-store" },
        },
        principal: { owner_scope: "owner-a" },
        restore: null,
        remaining_budget_usd: 25,
      }),
    );
    const claim = await gateway.bootstrapClaim({
      execution_id: "exec-1",
      execution_generation: 2,
      credential: { kind: "launch_nonce", nonce: "wln_launch" },
    });

    expect(recorded[0]?.url).toBe(
      "http://gateway.internal/internal/worker/bootstrap-claim",
    );
    expect(recorded[0]?.headers.Authorization).toBe("Bearer wln_launch");
    expect(claim.session_credential).toBe("wsc_session");

    gateway.useCredential(claim.session_credential);
    await gateway.release({ ...scope, reason: "done" }).catch(() => {});
    expect(recorded[1]?.headers.Authorization).toBe("Bearer wsc_session");
  });

  test("asks for a checkpoint and a restore plan on the routes the API mounts", async () => {
    const answers: Record<string, unknown> = {
      "/internal/worker/checkpoint-request": {
        status: "ready",
        revision: 3,
        manifest_ref: "sessions/s/checkpoints/0000000003/att_1/p/manifest.json",
      },
      "/internal/worker/restore-plan": { status: "none" },
    };
    const { gateway, recorded } = client(({ url }) =>
      ok(answers[new URL(url).pathname]),
    );

    expect(
      await gateway.requestCheckpoint({
        ...scope,
        preparation: { status: "ready" },
      }),
    ).toEqual({
      status: "ready",
      revision: 3,
      manifest_ref: "sessions/s/checkpoints/0000000003/att_1/p/manifest.json",
    });
    const runtime = {
      engine: "claude",
      sdk_version: "0.3.270",
      cli_version: "2.1.270",
      profile_sha256: "a".repeat(64),
    };
    expect(await gateway.restorePlan({ ...scope, runtime })).toEqual({
      status: "none",
    });
    expect(recorded.map((entry) => new URL(entry.url).pathname)).toEqual([
      "/internal/worker/checkpoint-request",
      "/internal/worker/restore-plan",
    ]);
    expect(recorded[1]?.body).toEqual({ ...scope, runtime });
  });

  test("decodes an API error body into a typed decision", async () => {
    const { gateway } = client(() => apiError(409, "LEASE_EXPIRED"));
    const error = await gateway
      .heartbeat({ ...scope, attempt_state: "running" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(WorkerGatewayRequestError);
    expect((error as WorkerGatewayRequestError).code).toBe("LEASE_EXPIRED");
    expect(isOwnershipLost(error)).toBe(true);
    expect(isRetryable(error)).toBe(false);
  });

  test("treats a body that is not an API error as an untyped failure", async () => {
    // What an unrouted path or a proxy answers: HTML, not the error envelope.
    const { gateway } = client(
      () => new Response("<html>404</html>", { status: 404 }),
    );
    const error = (await gateway
      .pendingControl({ ...scope, answers_after: 0 })
      .catch((caught: unknown) => caught)) as WorkerGatewayRequestError;

    expect(error.code).toBeNull();
    expect(error.status).toBe(404);
    expect(error.retryable).toBe(false);
  });

  test("keeps a 5xx without a body retryable", async () => {
    const { gateway } = client(() => new Response("", { status: 503 }));
    const error = (await gateway
      .nextInput({ ...scope })
      .catch((caught: unknown) => caught)) as WorkerGatewayRequestError;

    expect(error.retryable).toBe(true);
    expect(isOwnershipLost(error)).toBe(false);
  });

  test("reports a socket that never answered as retryable", async () => {
    const { gateway } = client(() => {
      throw new Error("connect ECONNREFUSED");
    });
    const error = (await gateway
      .nextInput({ ...scope })
      .catch((caught: unknown) => caught)) as WorkerGatewayRequestError;

    expect(error.status).toBe(0);
    expect(error.retryable).toBe(true);
    expect(error.message).toContain("ECONNREFUSED");
  });

  test("a 2xx whose body breaks off is retryable, and the heartbeat keeps the lease", async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"lease_rem'));
            controller.error(new Error("socket closed mid-body"));
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    let beats = 0;
    const { gateway } = client(() => {
      beats += 1;
      return beats === 1
        ? broken()
        : ok({
            lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
            lease_remaining_ms: 30_000,
            auth_revision: 0,
            control_pending: false,
          });
    });
    const error = (await gateway
      .heartbeat({ ...scope, attempt_state: "running" })
      .catch((caught: unknown) => caught)) as WorkerGatewayRequestError;
    expect(error).toBeInstanceOf(WorkerGatewayRequestError);
    expect(error.retryable).toBe(true);
    expect(isOwnershipLost(error)).toBe(false);

    beats = 0;
    const lost: string[] = [];
    const heartbeat = new Heartbeat({
      gateway,
      scope: () => scope,
      attemptState: () => "running",
      intervalMs: 1,
      lease: { remainingMs: 30_000, sentAt: performance.now() },
      safetyMarginMs: 1_000,
      onLost: (reason) => lost.push(reason),
    });
    heartbeat.start();
    while (beats < 3) await Bun.sleep(5);
    await heartbeat.stop();
    expect(lost).toEqual([]);
  });

  test("a heartbeat answer with or without auth_revision keeps the lease", async () => {
    const answer = {
      lease_expires_at: new Date(Date.now() + 30_000).toISOString(),
      lease_remaining_ms: 30_000,
      control_pending: false,
    };
    for (const fromServer of [{ ...answer, auth_revision: 0 }, answer]) {
      let beats = 0;
      const { gateway } = client(() => {
        beats += 1;
        return ok(fromServer);
      });
      expect(
        await gateway.heartbeat({ ...scope, attempt_state: "running" }),
      ).toEqual(fromServer);
      beats = 0;
      const lost: string[] = [];
      const heartbeat = new Heartbeat({
        gateway,
        scope: () => scope,
        attemptState: () => "running",
        intervalMs: 1,
        lease: { remainingMs: 30_000, sentAt: performance.now() },
        safetyMarginMs: 1_000,
        onLost: (reason) => lost.push(reason),
      });
      heartbeat.start();
      while (beats < 3) await Bun.sleep(5);
      await heartbeat.stop();
      expect(lost).toEqual([]);
    }
  });

  test("refuses a success body that does not match the contract", async () => {
    const { gateway } = client(() => ok({ accepted_through: "not a number" }));
    const error = (await gateway
      .appendEvents({
        ...scope,
        batch_key: "b1",
        events: [
          {
            event: "system",
            data: { type: "system" },
            source_sequence: 1,
            occurred_at: new Date().toISOString(),
          },
        ],
      })
      .catch((caught: unknown) => caught)) as WorkerGatewayRequestError;

    expect(error).toBeInstanceOf(WorkerGatewayRequestError);
    expect(error.retryable).toBe(false);
  });

  test("sends the current traceparent per request and none when it is unset", async () => {
    const { gateway, recorded } = client(() => apiError(409, "conflict"));
    const first = `00-${"a".repeat(32)}-${"b".repeat(16)}-01`;
    let current: string | undefined;
    gateway.useTraceparent(() => current);

    await gateway.release({ ...scope, reason: "done" }).catch(() => {});
    current = first;
    await gateway.release({ ...scope, reason: "done" }).catch(() => {});

    expect(recorded[0]?.headers.traceparent).toBeUndefined();
    expect(recorded[1]?.headers.traceparent).toBe(first);
  });
});
