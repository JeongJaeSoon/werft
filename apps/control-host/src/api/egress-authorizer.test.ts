import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import type { BudgetAccountId } from "@werft-ai/contracts";
import * as schema from "@werft-ai/db";
import {
  createPostgresJudgmentEgress,
  createPostgresWorkerUnitOfWork,
  createProviderExchangeLedger,
} from "@werft-ai/db";
import { createLogger, type LogRecord } from "@werft-ai/observability";
import {
  admitsReservations,
  createWorkerGateway,
  hashJudgmentToken,
  type ProviderExchangeInput,
  type ProviderExchangeLedger,
  type SessionBudget,
  WorkerGatewayError,
} from "@werft-ai/platform";
import { acceptAllCheckpoints } from "@werft-ai/platform/testing/checkpoints";
import { createObjectRouteSigner } from "@werft-ai/storage";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { testCatalog } from "../testing/catalog.ts";
import { claimed } from "../testing/claims.ts";
import { TEST_OWNER } from "../testing/releases.ts";
import { createApiApp } from "./app.ts";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
  EGRESS_EXCHANGE_CALL_HEADER,
  EGRESS_EXCHANGES_PATH,
  EGRESS_USAGE_PATH,
  egressAuthorizerConfigFromEnv,
} from "./egress-authorizer.ts";
import { registerWorkerRoutes } from "./routes/workers/worker.ts";

const AUTHORIZER_TOKEN = "authorizer-token-for-tests-0123456789";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let gateway: ReturnType<typeof createWorkerGateway>;
let authorize: (request: Request) => Promise<Response>;
let settingsCaughtUp: () => Promise<void>;

beforeEach(async () => {
  settingsCaughtUp = async () => {};
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: testCatalog({
      provider: {
        kind: "anthropic",
        endpoint: "https://api.anthropic.invalid",
        auth: {
          kind: "api_key",
          value: "catalog-provider-key",
          ref: { stored: "connection:test-connection" },
        },
      },
      repositories: {
        "sample-app": {
          url: "https://git.invalid/agent/app.git",
          branch: "main",
          auth: { kind: "github_app", registered: true },
        },
      },
    }),
    checkpoints: acceptAllCheckpoints,
    settingsCaughtUp: () => settingsCaughtUp(),
    options: {
      sessionBudget: { costUsd: 1_000, tokens: null },
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
  test("a settings read that fails is 503 retryable on the provider route, never a grant on the last read", async () => {
    const claim = await claimed(db, gateway);
    settingsCaughtUp = async () => {
      throw Object.assign(new Error("terminating connection"), {
        code: "57P01",
      });
    };
    const provider = await ask({
      token: claim.runtime_config.provider.auth.token,
      purpose: "provider",
    });
    expect(provider.status).toBe(503);
    expect(await provider.json()).toMatchObject({
      code: "BACKEND_UNAVAILABLE",
      retryable: true,
    });
  });

  test("turns a live token into its upstream and the credential to inject", async () => {
    const claim = await claimed(db, gateway);
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
    const claim = await claimed(db, gateway);
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
    const claim = await claimed(db, gateway);
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
    const claim = await claimed(db, gateway);
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
    const claim = await claimed(db, gateway);
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
    const claim = await claimed(db, gateway);
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
    const claim = await claimed(db, gateway);
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
    // claude-opus-5's $25 out at the highest speed (6x) and geo (1.1x)
    // multiples either table has.
    expect(body).toEqual({ cost_usd: 0.165, priced_by: "table" });
    expect(row).toMatchObject({
      speed: "unknown",
      inferenceGeo: "unknown",
      webSearchRequests: 0,
      pricedBy: "table",
    });
  });

  test("a row from before the migration still matches its old proxy's retry", async () => {
    const claim = await claimed(db, gateway);
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

describe("the provider exchange ledger route", () => {
  const reserve = {
    model: "claude-opus-5",
    input_tokens: 900,
    output_tokens: 4_096,
    cache_creation_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
    cache_read_input_tokens: 0,
    estimated: true,
  };
  const used = { ...reserve, output_tokens: 40, estimated: false };
  let records: LogRecord[];
  let withLedger: (request: Request) => Promise<Response>;
  // Room for a few of these reserves; a test narrows it to none.
  let budget: SessionBudget;

  beforeEach(() => {
    budget = { costUsd: 25, tokens: null };
    records = [];
    withLedger = createEgressAuthorizer({
      gateway,
      logger: createLogger({
        sinks: [{ write: (record) => void records.push(record) }],
      }),
      exchanges: createProviderExchangeLedger(db, {
        admits: async () => admitsReservations(budget),
      }),
      token: AUTHORIZER_TOKEN,
    });
  });

  function send(body: unknown, options: { bearer?: string | null } = {}) {
    const bearer =
      options.bearer === undefined ? AUTHORIZER_TOKEN : options.bearer;
    return withLedger(
      new Request(`http://authorizer.invalid${EGRESS_EXCHANGES_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async function ledgerRows() {
    return db.select().from(schema.providerExchanges);
  }

  test("an API without the ledger answers the route 404, as an older one does", async () => {
    const response = await ask(
      { op: "renew", exchange_id: crypto.randomUUID() },
      { path: EGRESS_EXCHANGES_PATH },
    );
    expect(response.status).toBe(404);
  });

  test("the proxy's bearer is required and a malformed body is refused", async () => {
    const renew = { op: "renew", exchange_id: crypto.randomUUID() };
    expect((await send(renew, { bearer: null })).status).toBe(401);
    expect((await send(renew, { bearer: "x".repeat(40) })).status).toBe(401);
    expect((await send({ op: "close", exchange_id: "x" })).status).toBe(400);
    expect(
      (await send({ ...renew, session_id: crypto.randomUUID() })).status,
    ).toBe(400);
  });

  test("an open makes a row once; repeating it extends it; renewing answers what is there", async () => {
    const claim = await claimed(db, gateway);
    const open = {
      op: "open",
      exchange_id: crypto.randomUUID(),
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      reserve,
    };
    const created = await send(open);
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ state: "open" });
    const again = await send(open);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ state: "open" });
    const [row] = await ledgerRows();
    expect(row).toMatchObject({
      exchangeId: open.exchange_id,
      sessionId: claim.session_id,
      attemptId: claim.attempt_id,
      reserve: {
        model: "claude-opus-5",
        inputTokens: 900,
        outputTokens: 4_096,
        speed: "unknown",
        inferenceGeo: "unknown",
        estimated: true,
      },
    });

    const renewed = await send({ op: "renew", exchange_id: open.exchange_id });
    expect(await renewed.json()).toEqual({ state: "open" });
    const gone = await send({ op: "renew", exchange_id: crypto.randomUUID() });
    expect(gone.status).toBe(200);
    expect(await gone.json()).toEqual({ state: "gone" });
  });

  test("an open for no such attempt is 404 and one under another owner's id is 409", async () => {
    const claim = await claimed(db, gateway);
    const exchangeId = crypto.randomUUID();
    const missing = await send({
      op: "open",
      exchange_id: exchangeId,
      session_id: claim.session_id,
      attempt_id: "att-missing",
      reserve,
    });
    expect(missing.status).toBe(404);
    await send({
      op: "open",
      exchange_id: exchangeId,
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      reserve,
    });
    const other = await claimed(db, gateway);
    const conflict = await send({
      op: "open",
      exchange_id: exchangeId,
      session_id: other.session_id,
      attempt_id: other.attempt_id,
      reserve,
    });
    expect(conflict.status).toBe(409);
    expect(await ledgerRows()).toHaveLength(1);
  });

  test("a usage report deletes the row; a late open then answers settled and makes none", async () => {
    const claim = await claimed(db, gateway);
    const open = {
      op: "open",
      exchange_id: crypto.randomUUID(),
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      reserve,
    };
    await send(open);
    const reported = await withLedger(
      new Request(`http://authorizer.invalid${EGRESS_USAGE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${AUTHORIZER_TOKEN}`,
        },
        body: JSON.stringify({
          exchange_id: open.exchange_id,
          session_id: claim.session_id,
          attempt_id: claim.attempt_id,
          usage: used,
        }),
      }),
    );
    expect(reported.status).toBe(200);
    expect(await ledgerRows()).toEqual([]);
    const late = await send(open);
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ state: "settled" });
    expect(await ledgerRows()).toEqual([]);
  });

  test("a report from another owner leaves the row and logs a warning", async () => {
    const opener = await claimed(db, gateway);
    const reporter = await claimed(db, gateway);
    const exchangeId = crypto.randomUUID();
    await send({
      op: "open",
      exchange_id: exchangeId,
      session_id: opener.session_id,
      attempt_id: opener.attempt_id,
      reserve,
    });
    const reported = await withLedger(
      new Request(`http://authorizer.invalid${EGRESS_USAGE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${AUTHORIZER_TOKEN}`,
        },
        body: JSON.stringify({
          exchange_id: exchangeId,
          session_id: reporter.session_id,
          attempt_id: reporter.attempt_id,
          usage: used,
        }),
      }),
    );
    expect(reported.status).toBe(200);
    expect(await ledgerRows()).toHaveLength(1);
    expect(
      records.filter(
        (record) =>
          record.message === "Provider exchange ledger row names another owner",
      ),
    ).toEqual([
      expect.objectContaining({
        level: "warn",
        fields: {
          exchange_id: exchangeId,
          session_id: reporter.session_id,
          attempt_id: reporter.attempt_id,
        },
      }),
    ]);
  });

  test("an open the session's budget cannot hold answers 403 BUDGET_EXCEEDED and makes no row", async () => {
    const claim = await claimed(db, gateway);
    budget.costUsd = 0.000_001;
    const refused = await send({
      op: "open",
      exchange_id: crypto.randomUUID(),
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      reserve,
    });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "BUDGET_EXCEEDED" });
    expect(await ledgerRows()).toEqual([]);
  });

  test("a release marks the call and its late open answers released; one for no such attempt is 404", async () => {
    const claim = await claimed(db, gateway);
    const call = {
      exchange_id: crypto.randomUUID(),
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      reserve,
    };
    const released = await send({ op: "release", ...call });
    expect(released.status).toBe(200);
    expect(await released.json()).toEqual({ state: "released" });
    const late = await send({ op: "open", ...call });
    expect(late.status).toBe(200);
    expect(await late.json()).toEqual({ state: "released" });

    const missing = await send({
      op: "release",
      ...call,
      exchange_id: crypto.randomUUID(),
      attempt_id: "att-missing",
    });
    expect(missing.status).toBe(404);
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
    const claim = await claimed(db, gateway);
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
      ownerId: TEST_OWNER,
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
      catalog: testCatalog({
        repositories: {},
      }),
      checkpoints: acceptAllCheckpoints,
      judgments: {
        store: createPostgresJudgmentEgress(db),
        upstream: async () => LUNA,
      },
      options: {
        sessionBudget: { costUsd: 1_000, tokens: null },
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
    const claim = await claimed(db, gateway);
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
    const claim = await claimed(db, gateway);
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
    const claim = await claimed(db, gateway);
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
    const claim = await claimed(db, gateway);
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
    const claim = await claimed(db, gateway);
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
        authorizeConversationCallEgress: async () => null,
        recordConversationCallUsage: refuse,
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
        authorizeConversationCallEgress: async () => null,
        recordConversationCallUsage: refuse,
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

describe("the budget account an open holds its call on", () => {
  const reserve = {
    model: "claude-opus-5",
    input_tokens: 900,
    output_tokens: 4_096,
    cache_creation_input_tokens: 0,
    cache_creation_1h_input_tokens: 0,
    cache_read_input_tokens: 0,
    estimated: true,
  };
  const PERSON = "11111111-1111-4111-8111-111111111111";
  const ACCOUNT = "44444444-4444-4444-8444-444444444444";
  const proxyAuth = "p".repeat(48);
  const choice = {
    rootKind: "user",
    owner: { kind: "user", userId: PERSON },
  } as const;

  function authorizerWith(
    open: ProviderExchangeLedger["open"],
    records: LogRecord[] = [],
    recordAccountRefusal?: Parameters<
      typeof createEgressAuthorizer
    >[0]["recordAccountRefusal"],
  ) {
    const seen: { op: string; input: ProviderExchangeInput }[] = [];
    const asked: {
      exchangeId: string;
      sessionId: string;
      attemptId: string;
      title?: boolean;
    }[] = [];
    const handle = createEgressAuthorizer({
      gateway,
      logger: createLogger({
        sinks: [{ write: (record) => void records.push(record) }],
      }),
      exchanges: {
        open: async (input) => {
          seen.push({ op: "open", input });
          return open(input);
        },
        renew: async () => "open",
        release: async (input) => {
          seen.push({ op: "release", input });
          return "released";
        },
      },
      budgetOf: async (call) => {
        asked.push(call);
        return { choice, turnId: "3" };
      },
      ...(recordAccountRefusal === undefined ? {} : { recordAccountRefusal }),
      token: proxyAuth,
    });
    const send = (body: unknown, extra: Record<string, string> = {}) =>
      handle(
        new Request(`http://authorizer.invalid${EGRESS_EXCHANGES_PATH}`, {
          method: "POST",
          headers: {
            ...extra,
            "content-type": "application/json",
            authorization: `Bearer ${proxyAuth}`,
          },
          body: JSON.stringify(body),
        }),
      );
    return { send, seen, asked };
  }

  const call = {
    exchange_id: "55555555-5555-4555-8555-555555555555",
    session_id: "66666666-6666-4666-8666-666666666666",
    attempt_id: "att-1",
    reserve,
  };

  test("an open passes the chosen account; a release asks for none", async () => {
    const { send, seen, asked } = authorizerWith(async () => ({
      outcome: "created",
    }));
    expect((await send({ op: "open", ...call })).status).toBe(201);
    expect((await send({ op: "release", ...call })).status).toBe(200);
    expect(asked).toEqual([
      {
        exchangeId: call.exchange_id,
        sessionId: call.session_id,
        attemptId: call.attempt_id,
      },
    ]);
    expect(seen.map(({ op, input }) => [op, input.budget])).toEqual([
      ["open", choice],
      ["release", undefined],
    ]);
  });

  // Before 94S-2019 a title call asked for no account and was held on the
  // session's limit alone; it is now the session's, its first turn's account.
  test("a title call's open asks for the session's account, not the running turn's", async () => {
    const { send, seen, asked } = authorizerWith(async () => ({
      outcome: "created",
    }));
    const title = { [EGRESS_EXCHANGE_CALL_HEADER]: "title" };
    expect((await send({ op: "open", ...call }, title)).status).toBe(201);
    expect(asked).toEqual([
      {
        exchangeId: call.exchange_id,
        sessionId: call.session_id,
        attemptId: call.attempt_id,
        title: true,
      },
    ]);
    expect(seen.map(({ op, input }) => [op, input.budget])).toEqual([
      ["open", choice],
    ]);
    // Any other value is an engine call's open, charged to its turn.
    const other = { [EGRESS_EXCHANGE_CALL_HEADER]: "engine" };
    expect((await send({ op: "open", ...call }, other)).status).toBe(201);
    expect(asked[1]).toEqual({
      exchangeId: call.exchange_id,
      sessionId: call.session_id,
      attemptId: call.attempt_id,
    });
  });

  test("an account's refusal is BUDGET_EXCEEDED, logged with the side, root kind and account", async () => {
    const records: LogRecord[] = [];
    const { send } = authorizerWith(
      async () => ({
        outcome: "budget_exceeded",
        by: "account",
        accountId: ACCOUNT as BudgetAccountId,
        owner: "user",
      }),
      records,
    );
    const refused = await send({ op: "open", ...call });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { code: string }).code).toBe(
      "BUDGET_EXCEEDED",
    );
    const logged = records.find(
      (record) => record.message === "Provider exchange refused for the budget",
    );
    expect(logged?.fields).toEqual({
      session_id: call.session_id,
      attempt_id: call.attempt_id,
      turn_id: "3",
      refused_by: "account",
      budget_root_kind: "user",
      budget_account_id: ACCOUNT,
    });
  });

  test("an account's refusal is kept on its session, and stands when keeping it fails", async () => {
    const kept: unknown[] = [];
    const refusal = async () => ({
      outcome: "budget_exceeded" as const,
      by: "account" as const,
      accountId: ACCOUNT as BudgetAccountId,
      owner: "team" as const,
    });
    const told: LogRecord[] = [];
    const { send } = authorizerWith(refusal, told, async (input) => {
      kept.push(input);
      return "recorded";
    });
    const refused = await send({ op: "open", ...call });
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      code: "BUDGET_EXCEEDED",
      message:
        "The budget account this call is charged to cannot hold its reserve",
    });
    expect(kept).toEqual([
      {
        sessionId: call.session_id,
        attemptId: call.attempt_id,
        // The turn the call was chosen for, as the refusal's log names it.
        turnId: "3",
        owner: "team",
      },
    ]);
    expect(
      told.find((record) => record.message === "Budget account refusal kept")
        ?.fields,
    ).toEqual({
      session_id: call.session_id,
      attempt_id: call.attempt_id,
      result: "recorded",
    });

    const records: LogRecord[] = [];
    const failing = authorizerWith(refusal, records, async () => {
      throw new Error("database gone");
    });
    const still = await failing.send({ op: "open", ...call });
    expect(still.status).toBe(403);
    expect(((await still.json()) as { code: string }).code).toBe(
      "BUDGET_EXCEEDED",
    );
    expect(
      records.find(
        (record) => record.message === "Budget account refusal not recorded",
      )?.fields,
    ).toEqual({
      session_id: call.session_id,
      attempt_id: call.attempt_id,
      error: "Error",
    });
  });

  test("a session's refusal is not kept as an account's", async () => {
    const kept: unknown[] = [];
    const { send } = authorizerWith(
      async () => ({
        outcome: "budget_exceeded",
        by: "session",
        accountId: null,
        owner: null,
      }),
      [],
      async (input) => {
        kept.push(input);
        return "recorded";
      },
    );
    const refused = await send({ op: "open", ...call });
    expect(((await refused.json()) as { message: string }).message).toBe(
      "The session's spend with this call's reserve reaches its cost or token limit",
    );
    expect(kept).toEqual([]);
  });

  test("a session's refusal names the session and no account", async () => {
    const records: LogRecord[] = [];
    const { send } = authorizerWith(
      async () => ({
        outcome: "budget_exceeded",
        by: "session",
        accountId: null,
        owner: null,
      }),
      records,
    );
    expect((await send({ op: "open", ...call })).status).toBe(403);
    const logged = records.find(
      (record) => record.message === "Provider exchange refused for the budget",
    );
    expect(logged?.fields).toMatchObject({
      refused_by: "session",
      budget_root_kind: "user",
    });
    expect(logged?.fields?.budget_account_id).toBeUndefined();
  });
});

describe("a decision the store could not give", () => {
  const unreadable = Object.assign(new Error("connect ECONNREFUSED"), {
    code: "ECONNREFUSED",
  });

  function asking(
    authorizeConversationCallEgress: () => Promise<never>,
    deadlineMs?: number,
  ) {
    const records: LogRecord[] = [];
    const answer = createEgressAuthorizer({
      gateway: { ...gateway, authorizeConversationCallEgress },
      logger: createLogger({
        sinks: [{ write: (record) => void records.push(record) }],
      }),
      token: AUTHORIZER_TOKEN,
      ...(deadlineMs === undefined ? {} : { deadlineMs }),
    });
    return {
      records,
      ask: () =>
        answer(
          new Request(`http://authorizer.invalid${EGRESS_AUTHORIZER_PATH}`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${AUTHORIZER_TOKEN}`,
            },
            body: JSON.stringify({ token: "weg_any", purpose: "provider" }),
          }),
        ),
    };
  }

  test("a store that cannot be read is answered 503 and retryable, never with a grant", async () => {
    const { ask, records } = asking(async () => {
      throw unreadable;
    });
    const response = await ask();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("1");
    expect(await response.json()).toEqual({
      code: "BACKEND_UNAVAILABLE",
      message: "Authorization unavailable",
      retryable: true,
    });
    expect(records.map((record) => record.message)).toEqual([
      "Egress authorization undecided: storage unavailable",
    ]);
  });

  test("a decision past its deadline is retryable the same way", async () => {
    const { ask } = asking(() => new Promise<never>(() => {}), 10);
    const response = await ask();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "BACKEND_UNAVAILABLE",
      message: "Authorization timed out",
      retryable: true,
    });
  });

  test("any other failure is a 503 that is not marked retryable", async () => {
    const { ask, records } = asking(async () => {
      throw new Error("a bug, not an outage");
    });
    const response = await ask();
    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBeNull();
    expect(await response.json()).toEqual({
      code: "BACKEND_UNAVAILABLE",
      message: "Authorization unavailable",
    });
    expect(records.map((record) => record.message)).toEqual([
      "Egress authorization failed",
    ]);
  });

  test("a refusal stays a refusal", async () => {
    const response = await ask({ token: "weg_unknown", purpose: "provider" });
    expect(response.status).toBe(401);
    expect(await response.json()).not.toHaveProperty("retryable");
  });
});
