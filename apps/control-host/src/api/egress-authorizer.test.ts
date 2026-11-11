import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import {
  createPostgresJudgmentEgress,
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import { createLogger } from "@werft-ai/observability";
import {
  acceptAllCheckpoints,
  createWorkerGateway,
  hashJudgmentToken,
  WorkerGatewayError,
  withSeededInstallation,
} from "@werft-ai/platform";
import { createObjectRouteSigner } from "@werft-ai/storage";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { createApiApp } from "./app.ts";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
  EGRESS_USAGE_PATH,
  egressAuthorizerConfigFromEnv,
} from "./egress-authorizer.ts";
import { registerWorkerRoutes } from "./routes/workers/worker.ts";

const AUTHORIZER_TOKEN = "authorizer-token-for-tests-0123456789";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let gateway: ReturnType<typeof createWorkerGateway>;
let authorize: (request: Request) => Promise<Response>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: withSeededInstallation({
      profiles: {
        "claude-coding-v1": {
          runtime_kind: "claude_agent_sdk",
          runtime_version: "0.3.270",
          model: "claude-sonnet-5",
          tools: ["Read"],
          permission_mode: "default",
          provider: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            auth: {
              kind: "api_key",
              value: "catalog-provider-key",
              ref: { value_env: "PROVIDER_KEY" },
            },
          },
        },
      },
      repositories: {
        "sample-app": {
          url: "https://git.invalid/agent/app.git",
          branch: "main",
          profiles: ["claude-coding-v1"],
          auth: { kind: "github_app", registered: true },
        },
      },
    }),
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: 1_000,
      sessionTokenLimit: null,
      leaseTtlMs: 60_000,
    },
  });
  authorize = createEgressAuthorizer({
    gateway,
    logger: createLogger({ sinks: [] }),
    token: AUTHORIZER_TOKEN,
  });
});

afterEach(async () => {
  await client.close();
});

async function claimed() {
  const accepted = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: { ownerId: "owner-a" },
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "hash",
    profileId: "claude-coding-v1",
    repository: {
      id: "sample-app",
      url: "https://git.invalid/agent/app.git",
      branch: "main",
    },
    message: "hello",
  });
  if (accepted.outcome !== "accepted") throw new Error(accepted.outcome);
  const launch = await launchSession(db, {
    sessionId: accepted.response.session_id,
  });
  return await gateway.bootstrapClaim(
    { kind: "bootstrap" },
    {
      execution_id: launch.executionId,
      execution_generation: launch.generation,
      credential: { kind: "launch_nonce", nonce: launch.nonce },
    },
  );
}

function ask(
  body: unknown,
  options: { bearer?: string | null; path?: string; method?: string } = {},
) {
  const bearer =
    options.bearer === undefined ? AUTHORIZER_TOKEN : options.bearer;
  return authorize(
    new Request(
      `http://authorizer.invalid${options.path ?? EGRESS_AUTHORIZER_PATH}`,
      {
        method: options.method ?? "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
  );
}

describe("egress authorizer", () => {
  test("turns a live token into its upstream and the credential to inject", async () => {
    const claim = await claimed();
    const provider = await ask({
      token: claim.runtime_config.provider.auth.token,
      purpose: "provider",
    });
    expect(provider.status).toBe(200);
    expect(await provider.json()).toEqual({
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      upstream: {
        url: "https://api.anthropic.invalid",
        headers: [["x-api-key", "catalog-provider-key"]],
      },
    });
  });

  test("a packages token opens a public registry with no credential, and nothing else", async () => {
    const claim = await claimed();
    const packages = claim.packages?.access.token ?? "";
    expect(packages.startsWith("wek_")).toBe(true);
    const npm = await ask({
      token: packages,
      purpose: "packages",
      registry: "npm",
    });
    expect(npm.status).toBe(200);
    expect(await npm.json()).toEqual({
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      upstream: { url: "https://registry.npmjs.org", headers: [] },
    });
    const gosum = await ask({
      token: packages,
      purpose: "packages",
      registry: "gosum",
    });
    expect((await gosum.json()).upstream.url).toBe("https://sum.golang.org");
    // A registry the route never names, and a token for another route.
    expect(
      (await ask({ token: packages, purpose: "packages", registry: "pypi" }))
        .status,
    ).toBe(400);
    expect(
      (
        await ask({
          token: claim.object_store.access.token,
          purpose: "packages",
          registry: "npm",
        })
      ).status,
    ).toBe(401);
    expect((await ask({ token: packages, purpose: "provider" })).status).toBe(
      401,
    );
  });

  test("answers nothing without its own bearer, whatever the token", async () => {
    const claim = await claimed();
    const body = {
      token: claim.runtime_config.provider.auth.token,
      purpose: "provider",
    };
    for (const bearer of [null, "wrong", `${AUTHORIZER_TOKEN}x`, ""]) {
      const response = await ask(body, { bearer });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("catalog-provider-key");
    }
    // The worker's own session credential is not the authorizer's bearer.
    expect((await ask(body, { bearer: claim.session_credential })).status).toBe(
      401,
    );
  });

  test("refuses anything but one small, well-formed request", async () => {
    const claim = await claimed();
    const token = claim.runtime_config.provider.auth.token;
    expect(
      (await ask({ token, purpose: "provider" }, { path: "/" })).status,
    ).toBe(404);
    expect(
      (await ask({ token, purpose: "provider" }, { method: "PUT" })).status,
    ).toBe(404);
    for (const body of [
      "not json",
      { token },
      { token, purpose: "gateway" },
      { token, purpose: "provider", extra: true },
      { token: "", purpose: "provider" },
    ]) {
      expect((await ask(body)).status).toBe(400);
    }
    expect(
      (await ask({ token: "x".repeat(20 * 1024), purpose: "provider" })).status,
    ).toBe(413);
  });

  test("a chunked body is refused at 16 KiB, before the rest is read", async () => {
    let pulled = 0;
    const response = await authorize(
      new Request(`http://authorizer.invalid${EGRESS_AUTHORIZER_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${AUTHORIZER_TOKEN}`,
        },
        // 17 KiB, then a body that never ends.
        body: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            if (pulled <= 17) controller.enqueue(new Uint8Array(1024));
            else return new Promise(() => {});
          },
        }),
      }),
    );
    expect(response.status).toBe(413);
    expect(pulled).toBeLessThanOrEqual(18);
  });

  test("an unknown token is 401, and a token for the other route too", async () => {
    const claim = await claimed();
    expect(
      (await ask({ token: "wep_unknown", purpose: "provider" })).status,
    ).toBe(401);
    expect(
      (
        await ask({
          token: claim.runtime_config.provider.auth.token,
          purpose: "repository",
        })
      ).status,
    ).toBe(401);
  });

  test("is not a route on the API's own listener, which workers can reach", async () => {
    const claim = await claimed();
    const app = createApiApp({
      authMode: "api-key",
      registerInternalRoutes: (router) => registerWorkerRoutes(router, gateway),
    });
    for (const path of [
      EGRESS_AUTHORIZER_PATH,
      `/internal${EGRESS_AUTHORIZER_PATH}`,
      `/internal/worker${EGRESS_AUTHORIZER_PATH}`,
    ]) {
      const response = await app.request(path, {
        method: "POST",
        headers: {
          authorization: `Bearer ${AUTHORIZER_TOKEN}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          token: claim.runtime_config.provider.auth.token,
          purpose: "provider",
        }),
      });
      expect(response.status).not.toBe(200);
      expect(await response.text()).not.toContain("catalog-provider-key");
    }
  });
});

describe("usage reports", () => {
  const counts = {
    input_tokens: 0,
    output_tokens: 1_000,
    cache_creation_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
    cache_read_input_tokens: 0,
    estimated: false,
  };

  async function report(usage: Record<string, unknown>) {
    const claim = await claimed();
    const exchangeId = crypto.randomUUID();
    const response = await ask(
      {
        exchange_id: exchangeId,
        session_id: claim.session_id,
        attempt_id: claim.attempt_id,
        usage: { model: "claude-opus-5", ...counts, ...usage },
      },
      { path: EGRESS_USAGE_PATH },
    );
    const [row] = await db
      .select({
        speed: schema.providerUsage.speed,
        inferenceGeo: schema.providerUsage.inferenceGeo,
        webSearchRequests: schema.providerUsage.webSearchRequests,
        webFetchRequests: schema.providerUsage.webFetchRequests,
        codeExecutionRequests: schema.providerUsage.codeExecutionRequests,
        pricedBy: schema.providerUsage.pricedBy,
      })
      .from(schema.providerUsage)
      .where(eq(schema.providerUsage.exchangeId, exchangeId));
    const [session] = await db
      .select({ costUsd: schema.sessions.costUsd })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, claim.session_id));
    return {
      status: response.status,
      body: await response.json(),
      row,
      sessionCost: session?.costUsd,
    };
  }

  test("a fast call's searches are charged on top of its fast rate, and the ledger row keeps both", async () => {
    // claude-opus-5 fast: $50 out per million; two searches at $0.01.
    expect(
      await report({
        speed: "fast",
        inference_geo: "global",
        web_search_requests: 2,
        web_fetch_requests: 4,
        code_execution_requests: 1,
      }),
    ).toEqual({
      status: 200,
      body: { cost_usd: 0.07, priced_by: "table" },
      row: {
        speed: "fast",
        inferenceGeo: "global",
        webSearchRequests: 2,
        webFetchRequests: 4,
        codeExecutionRequests: 1,
        pricedBy: "table",
      },
      sessionCost: 0.07,
    });
  });

  test("a US-only call pays 1.1x and the ledger row says so", async () => {
    // claude-opus-5: $25 out per million.
    const { body, row } = await report({
      speed: "standard",
      inference_geo: "us",
    });
    expect(body).toEqual({ cost_usd: 0.0275, priced_by: "table" });
    expect(row).toMatchObject({ inferenceGeo: "us", pricedBy: "table" });
  });

  test("a report from a proxy that does not send the speed or the geo is priced high", async () => {
    const { status, body, row } = await report({});
    expect(status).toBe(200);
    expect(body.priced_by).toBe("fallback");
    expect(row).toMatchObject({
      speed: "unknown",
      inferenceGeo: "unknown",
      webSearchRequests: 0,
      pricedBy: "fallback",
    });
  });

  test("a row from before the migration still matches its old proxy's retry", async () => {
    const claim = await claimed();
    const exchangeId = crypto.randomUUID();
    // Written as wrote it: no speed, no tool counts.
    await db.insert(schema.providerUsage).values({
      exchangeId,
      sessionId: claim.session_id,
      attemptId: claim.attempt_id,
      model: "claude-opus-5",
      inputTokens: 0,
      outputTokens: 1_000,
      cacheCreationInputTokens: 0,
      cacheCreation1hInputTokens: 0,
      cacheReadInputTokens: 0,
      estimated: false,
      costUsd: 0.025,
      pricedBy: "table",
    });
    const retry = await ask(
      {
        exchange_id: exchangeId,
        session_id: claim.session_id,
        attempt_id: claim.attempt_id,
        usage: { model: "claude-opus-5", ...counts },
      },
      { path: EGRESS_USAGE_PATH },
    );
    expect(retry.status).toBe(200);
    // Priced today it would be the fallback; the answer is what was charged.
    expect(await retry.json()).toEqual({ cost_usd: 0.025, priced_by: "table" });
  });
});

describe("the judgment route", () => {
  const LUNA = {
    url: "https://decisions.example.invalid",
    headers: [["authorization", "Bearer judge-key"]] as Array<[string, string]>,
  };
  const TOKEN = "wej_judgment-token";

  /** A running judgment of a claimed session, holding TOKEN. */
  async function judging(settings: Record<string, unknown>) {
    const claim = await claimed();
    const workspaceId = crypto.randomUUID();
    await db.insert(schema.workspaces).values({
      id: workspaceId,
      slug: `judge-${workspaceId.slice(0, 8)}`,
      name: "judge",
      settings: { achievement_judge: settings },
    });
    await db
      .update(schema.sessions)
      .set({ workspaceId })
      .where(eq(schema.sessions.id, claim.session_id));
    const judgmentId = crypto.randomUUID();
    await db.insert(schema.achievementJudgments).values({
      id: judgmentId,
      workspaceId,
      ownerId: "owner-a",
      sessionId: claim.session_id,
      trigger: "evidence",
      status: "running",
      nextAttemptAt: new Date(),
      leaseToken: crypto.randomUUID(),
      leaseExpiresAt: new Date(Date.now() + 60_000),
      tokenHash: hashJudgmentToken(TOKEN),
    });
    const judged = createWorkerGateway({
      work: createPostgresWorkerUnitOfWork(db),
      catalog: withSeededInstallation({ profiles: {}, repositories: {} }),
      checkpoints: acceptAllCheckpoints,
      judgments: {
        store: createPostgresJudgmentEgress(db),
        upstream: async () => LUNA,
      },
      options: {
        sessionCostLimitUsd: 1_000,
        sessionTokenLimit: null,
        leaseTtlMs: 60_000,
      },
    });
    authorize = createEgressAuthorizer({
      gateway: judged,
      logger: createLogger({ sinks: [] }),
      token: AUTHORIZER_TOKEN,
    });
    return { claim, judgmentId };
  }

  test("a judgment token is granted under its judgment; its use lands on the judgment and the session's spend stays", async () => {
    const { claim, judgmentId } = await judging({
      connection_id: "luna-main",
    });
    const granted = await ask({ token: TOKEN, purpose: "judgment" });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({
      judgment_id: judgmentId,
      upstream: LUNA,
    });

    const reported = await ask(
      {
        exchange_id: crypto.randomUUID(),
        judgment_id: judgmentId,
        usage: {
          model: "gpt-6-luna",
          input_tokens: 600,
          output_tokens: 3,
          cache_creation_input_tokens: 0,
          cache_creation_1h_input_tokens: 0,
          cache_read_input_tokens: 0,
          estimated: false,
        },
      },
      { path: EGRESS_USAGE_PATH },
    );
    expect(reported.status).toBe(200);
    expect(await reported.json()).toEqual({
      cost_usd: 0.00006,
      priced_by: "table",
    });
    const [ledger] = await db
      .select({
        calls: schema.achievementJudgments.calls,
        inputTokens: schema.achievementJudgments.inputTokens,
        costUsd: schema.achievementJudgments.costUsd,
      })
      .from(schema.achievementJudgments)
      .where(eq(schema.achievementJudgments.id, judgmentId));
    expect(ledger).toEqual({ calls: 1, inputTokens: 600, costUsd: 0.00006 });
    const [session] = await db
      .select({
        costUsd: schema.sessions.costUsd,
        providerTokens: schema.sessions.providerTokens,
      })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, claim.session_id));
    expect(session).toEqual({ costUsd: 0, providerTokens: 0 });
    expect(await db.select().from(schema.providerUsage)).toEqual([]);
  });

  test("a judgment token is refused on every session route, and a session token on the judgment route", async () => {
    await judging({ connection_id: "luna-main" });
    for (const purpose of ["provider", "repository"]) {
      expect((await ask({ token: TOKEN, purpose })).status).toBe(401);
    }
    expect(
      (await ask({ token: TOKEN, purpose: "packages", registry: "npm" }))
        .status,
    ).toBe(401);
    expect(
      (await ask({ token: "wep_engine-token", purpose: "judgment" })).status,
    ).toBe(401);
  });

  test("a workspace past the day's judgment budget is refused", async () => {
    const { judgmentId } = await judging({
      connection_id: "luna-main",
      daily_budget_usd: 0.5,
    });
    const [judged] = await db
      .select({ workspaceId: schema.achievementJudgments.workspaceId })
      .from(schema.achievementJudgments)
      .where(eq(schema.achievementJudgments.id, judgmentId));
    if (!judged) throw new Error("no judgment");
    await db.insert(schema.achievementJudgmentUsage).values({
      exchangeId: crypto.randomUUID(),
      judgmentId,
      workspaceId: judged.workspaceId,
      inputTokens: 1,
      costUsd: 0.5,
    });
    const refused = await ask({ token: TOKEN, purpose: "judgment" });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "BUDGET_EXCEEDED" });
  });
});

describe("egressAuthorizerConfigFromEnv", () => {
  test("is off without both variables and refuses half a pair or a weak token", () => {
    expect(egressAuthorizerConfigFromEnv({})).toBeNull();
    expect(
      egressAuthorizerConfigFromEnv({
        EGRESS_AUTHORIZER_PORT: "3100",
        EGRESS_AUTHORIZER_TOKEN: AUTHORIZER_TOKEN,
      }),
    ).toEqual({ hostname: "0.0.0.0", port: 3100, token: AUTHORIZER_TOKEN });
    expect(() =>
      egressAuthorizerConfigFromEnv({ EGRESS_AUTHORIZER_PORT: "3100" }),
    ).toThrow(/set together/);
    expect(() =>
      egressAuthorizerConfigFromEnv({
        EGRESS_AUTHORIZER_TOKEN: AUTHORIZER_TOKEN,
      }),
    ).toThrow(/set together/);
    expect(() =>
      egressAuthorizerConfigFromEnv({
        EGRESS_AUTHORIZER_PORT: "3100",
        EGRESS_AUTHORIZER_TOKEN: "short",
      }),
    ).toThrow(/at least 32/);
    expect(() =>
      egressAuthorizerConfigFromEnv({
        EGRESS_AUTHORIZER_PORT: "http",
        EGRESS_AUTHORIZER_TOKEN: AUTHORIZER_TOKEN,
      }),
    ).toThrow(/not a port/);
  });
});

describe("the object store route's answers", () => {
  const signed = (withSigner = true) =>
    createEgressAuthorizer({
      gateway,
      logger: createLogger({ sinks: [] }),
      token: AUTHORIZER_TOKEN,
      ...(withSigner
        ? {
            objectStore: createObjectRouteSigner({
              bucket: "claude-sessions",
              credentials: {
                accessKeyId: "AKIDCONTROLHOST",
                secretAccessKey: "control-host-secret",
              },
              endpoint: "http://localstack.invalid:4566",
              region: "ap-northeast-1",
            }),
          }
        : {}),
    });
  const objectAsk = (
    authorizer: typeof authorize,
    token: string,
    method: string,
    target: string,
    headers: Array<[string, string]> = [],
  ) =>
    authorizer(
      new Request(`http://authorizer.invalid${EGRESS_AUTHORIZER_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${AUTHORIZER_TOKEN}`,
        },
        body: JSON.stringify({
          token,
          purpose: "object_store",
          request: { method, target, headers },
        }),
      }),
    );

  test("signs a request under the session's prefix with the API's own key", async () => {
    const claim = await claimed();
    const response = await objectAsk(
      signed(),
      claim.object_store.access.token,
      "PUT",
      `/claude-sessions/sessions/${claim.session_id}/x?x-id=PutObject`,
      [
        ["content-length", "4"],
        ["if-none-match", "*"],
      ],
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      upstream: { headers: Array<[string, string]> };
    };
    expect(body).toMatchObject({
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      upstream: {
        url: "http://localstack.invalid:4566",
        target: `/claude-sessions/sessions/${claim.session_id}/x`,
      },
    });
    const headers = new Map(body.upstream.headers);
    expect(headers.get("authorization")).toContain(
      "Credential=AKIDCONTROLHOST/",
    );
    expect(headers.get("content-length")).toBe("4");
  });

  test("refuses what the session may not do, with the reason", async () => {
    const claim = await claimed();
    const token = claim.object_store.access.token;
    for (const [method, target] of [
      ["GET", "/claude-sessions/sessions/another-session/x"],
      ["GET", "/claude-sessions?list-type=2&prefix=sessions%2F"],
      ["DELETE", `/claude-sessions/sessions/${claim.session_id}/x`],
      ["PUT", `/claude-sessions/sessions/${claim.session_id}/x?legal-hold`],
    ] as const) {
      const response = await objectAsk(signed(), token, method, target, [
        ["content-length", "0"],
      ]);
      expect(`${method} ${target} ${response.status}`).toBe(
        `${method} ${target} 403`,
      );
      expect(await response.text()).not.toContain("AKIDCONTROLHOST");
    }
  });

  test("each token opens its own route and no other", async () => {
    const claim = await claimed();
    const target = `/claude-sessions/sessions/${claim.session_id}/x`;
    const repository = claim.workspace.repository?.access;
    if (repository === undefined) throw new Error("no repository token");
    for (const token of [
      claim.runtime_config.provider.auth.token,
      repository.token,
      "weo_unknown",
    ]) {
      expect((await objectAsk(signed(), token, "GET", target)).status).toBe(
        401,
      );
    }
    expect(
      (
        await ask({
          token: claim.object_store.access.token,
          purpose: "provider",
        })
      ).status,
    ).toBe(401);
  });

  test("an API with no object store answers 503, and only for a live token", async () => {
    const claim = await claimed();
    const target = `/claude-sessions/sessions/${claim.session_id}/x`;
    expect(
      (
        await objectAsk(
          signed(false),
          claim.object_store.access.token,
          "GET",
          target,
        )
      ).status,
    ).toBe(503);
    expect(
      (await objectAsk(signed(false), "weo_unknown", "GET", target)).status,
    ).toBe(401);
  });

  test("refuses a request line it cannot read", async () => {
    const claim = await claimed();
    const token = claim.object_store.access.token;
    const target = `/claude-sessions/sessions/${claim.session_id}/x`;
    expect((await objectAsk(signed(), token, "get", target)).status).toBe(400);
    expect(
      (
        await objectAsk(
          signed(),
          token,
          "GET",
          target,
          Array.from({ length: 33 }, (_, i) => [`x-amz-meta-${i}`, "v"]),
        )
      ).status,
    ).toBe(400);
    expect((await ask({ token, purpose: "object_store" })).status).toBe(400);
  });
});

describe("egress authorizer: remote MCP", () => {
  const RECEIPT = "0a1b2c3d-0000-5000-8000-000000000001";
  function withMcp(
    answer: (request: unknown) => Promise<unknown>,
  ): (request: Request) => Promise<Response> {
    const refuse = async () => {
      throw new Error("not this route");
    };
    return createEgressAuthorizer({
      gateway: {
        authorizeEgress: refuse,
        authorizeObjectAccess: refuse,
        authorizePackagesEgress: refuse,
        recordProviderUsage: refuse,
        authorizeJudgmentEgress: refuse,
        recordJudgmentUsage: refuse,
        authorizeMcpEgress: answer as never,
      },
      logger: createLogger({ sinks: [] }),
      token: AUTHORIZER_TOKEN,
    });
  }
  const body = {
    token: "wem_token",
    purpose: "mcp",
    server: "fake",
    rpc: { method: "tools/call", tool: "whoami" },
  };

  test("passes the server and call through, a regrant flagged", async () => {
    const asked: unknown[] = [];
    authorize = withMcp(async (request) => {
      asked.push(request);
      return {
        session_id: "s",
        attempt_id: "a",
        upstream: { url: "u", headers: [] },
      };
    });
    expect((await ask(body)).status).toBe(200);
    expect((await ask({ ...body, regrant: true })).status).toBe(200);
    expect(asked).toEqual([
      { ...body, regrant: false },
      { ...body, regrant: true },
    ]);
  });

  test("a refusal carries its receipt id, and only one with a receipt does", async () => {
    authorize = withMcp(async (request) => {
      const { rpc } = request as { rpc: { tool: string | null } };
      throw rpc.tool === "whoami"
        ? new WorkerGatewayError(
            403,
            "CREDENTIAL_UNBOUND",
            "unbound",
            false,
            RECEIPT,
          )
        : new WorkerGatewayError(403, "FORBIDDEN", "not pinned");
    });
    const refused = await ask(body);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      code: "CREDENTIAL_UNBOUND",
      message: "unbound",
      receipt_id: RECEIPT,
    });
    const other = await ask({
      ...body,
      rpc: { method: "tools/call", tool: "x" },
    });
    expect(await other.json()).toEqual({
      code: "FORBIDDEN",
      message: "not pinned",
    });
  });

  test("a GitHub refusal names its reason code to the proxy", async () => {
    const refuse = async () => {
      throw new Error("not this route");
    };
    authorize = createEgressAuthorizer({
      gateway: {
        authorizeEgress: async () => {
          throw new WorkerGatewayError(
            409,
            "GITHUB_REFUSED",
            "unsupported",
            false,
            undefined,
            "github_settings_unsupported",
          );
        },
        authorizeObjectAccess: refuse,
        authorizePackagesEgress: refuse,
        recordProviderUsage: refuse,
        authorizeJudgmentEgress: refuse,
        recordJudgmentUsage: refuse,
        authorizeMcpEgress: refuse,
      },
      logger: createLogger({ sinks: [] }),
      token: AUTHORIZER_TOKEN,
    });
    const refused = await ask({ token: "t", purpose: "repository" });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      code: "GITHUB_REFUSED",
      message: "unsupported",
      details: { reason_code: "github_settings_unsupported" },
    });
  });

  test("refuses a server name the route could not have sent", async () => {
    authorize = withMcp(async () => ({}));
    for (const bad of [
      { ...body, server: "a__b" },
      { ...body, server: "Fake" },
      { ...body, rpc: { method: "tools/call" } },
      { ...body, rpc: { method: "", tool: null } },
    ]) {
      expect((await ask(bad)).status).toBe(400);
    }
  });
});
