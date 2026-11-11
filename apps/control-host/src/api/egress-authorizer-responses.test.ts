import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import {
  createPostgresSessionUnitOfWork,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { launchSession } from "@werft-ai/db/testing/launches";
import { createLogger } from "@werft-ai/observability";
import { createWorkerGateway } from "@werft-ai/platform";
import { acceptAllCheckpoints } from "@werft-ai/platform/testing/checkpoints";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { releaseOnConnection, TEST_OWNER } from "../testing/releases.ts";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
  EGRESS_USAGE_PATH,
} from "./egress-authorizer.ts";

// The provider route's decision is the session's connection kind together with
// the path the proxy parsed: `/v1/responses` belongs to an `openai_responses`
// connection and the Messages paths to every other.
const AUTHORIZER_BEARER = "authorizer-bearer-for-responses-tests";
const OPENAI_KEY = "sk-openai-key-kept-from-the-worker";
const CLAUDE_KEY = "sk-claude-key-kept-from-the-worker";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let authorize: (request: Request) => Promise<Response>;

function build(costLimitUsd: number) {
  const gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog: {
      connections: {
        claude: {
          provider: {
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            auth: {
              kind: "api_key",
              value: CLAUDE_KEY,
              ref: { value_env: "CLAUDE_KEY" },
            },
          },
          models: ["claude-sonnet-5"],
          auto_mode: "unknown",
        },
        openai: {
          provider: {
            kind: "openai_responses",
            endpoint: "https://api.openai.invalid",
            auth: {
              kind: "api_key",
              value: OPENAI_KEY,
              ref: { value_env: "OPENAI_KEY" },
            },
          },
          models: ["gpt-5.5"],
          auto_mode: "unknown",
        },
      },
      repositories: {
        "sample-app": {
          url: "https://git.invalid/agent/app.git",
          branch: "main",
          auth: { kind: "github_app", registered: true },
        },
      },
    },
    checkpoints: acceptAllCheckpoints,
    options: {
      sessionCostLimitUsd: costLimitUsd,
      sessionTokenLimit: null,
      leaseTtlMs: 60_000,
    },
  });
  authorize = createEgressAuthorizer({
    gateway,
    logger: createLogger({ sinks: [] }),
    token: AUTHORIZER_BEARER,
  });
  return gateway;
}

let gateway: ReturnType<typeof build>;

beforeEach(async () => {
  client = await migratedPGlite();
  db = drizzle(client, { schema });
  gateway = build(1_000);
});

afterEach(async () => {
  await client.close();
});

/** A release on the connection, its spec naming that connection. */
async function releaseOn(connectionId: "claude" | "openai") {
  const model = connectionId === "claude" ? "claude-sonnet-5" : "gpt-5.5";
  const releaseId = await releaseOnConnection(db, {
    model,
    connection:
      connectionId === "claude"
        ? {
            id: "claude",
            kind: "anthropic",
            endpoint: "https://api.anthropic.invalid",
            billing: "per_token",
          }
        : {
            id: "openai",
            kind: "openai_responses",
            endpoint: "https://api.openai.invalid",
            billing: "per_token",
          },
  });
  return { releaseId, model };
}

async function claimed(connectionId: "claude" | "openai") {
  const { releaseId, model } = await releaseOn(connectionId);
  const accepted = await createPostgresSessionUnitOfWork(db).acceptInputAtomic({
    limits: { queuedInputLimitPerSession: 1_000, storageLimitBytes: 1e15 },
    principal: { ownerId: TEST_OWNER },
    idempotencyKey: crypto.randomUUID(),
    payloadHash: "hash",
    agentReleaseId: releaseId,
    model,
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

function ask(body: unknown, path = EGRESS_AUTHORIZER_PATH) {
  return authorize(
    new Request(`http://authorizer.invalid${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${AUTHORIZER_BEARER}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

type Claim = Awaited<ReturnType<typeof claimed>>;
const tokenOf = (claim: Claim) => claim.runtime_config.provider.auth.token;

describe("provider route by connection kind", () => {
  test("an openai_responses session is granted /v1/responses with the key as a bearer, and nothing of the Messages family", async () => {
    const claim = await claimed("openai");
    expect(claim.runtime_config.provider.kind).toBe("openai_responses");

    const granted = await ask({
      token: tokenOf(claim),
      purpose: "provider",
      path: "/v1/responses",
    });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({
      session_id: claim.session_id,
      attempt_id: claim.attempt_id,
      upstream: {
        url: "https://api.openai.invalid",
        headers: [["authorization", `Bearer ${OPENAI_KEY}`]],
      },
    });

    // No path is a Messages call, which this connection does not speak.
    const messages = await ask({ token: tokenOf(claim), purpose: "provider" });
    expect(messages.status).toBe(403);
    expect(await messages.text()).not.toContain(OPENAI_KEY);
  });

  test("a Claude session is refused /v1/responses and keeps its Messages route", async () => {
    const claim = await claimed("claude");
    const refused = await ask({
      token: tokenOf(claim),
      purpose: "provider",
      path: "/v1/responses",
    });
    expect(refused.status).toBe(403);
    const body = await refused.text();
    expect(body).not.toContain(CLAUDE_KEY);
    expect(body).not.toContain(OPENAI_KEY);

    const messages = await ask({ token: tokenOf(claim), purpose: "provider" });
    expect(messages.status).toBe(200);
    expect(await messages.json()).toMatchObject({
      upstream: {
        url: "https://api.anthropic.invalid",
        headers: [["x-api-key", CLAUDE_KEY]],
      },
    });
  });

  test("the path is the one Responses path or nothing, and only on the provider purpose", async () => {
    const claim = await claimed("openai");
    for (const body of [
      { token: tokenOf(claim), purpose: "provider", path: "/v1/messages" },
      { token: tokenOf(claim), purpose: "provider", path: "/v1/responses/x" },
      { token: tokenOf(claim), purpose: "provider", path: "/v1/models" },
      { token: tokenOf(claim), purpose: "repository", path: "/v1/responses" },
    ]) {
      expect((await ask(body)).status).toBe(400);
    }
  });

  test("a token of another route does not open /v1/responses", async () => {
    const claim = await claimed("openai");
    const repository = claim.repository_access?.token;
    // The repository token is for the git route; the provider purpose must
    // not honor it, whatever path is named.
    expect(claim.repository_access).toBeDefined();
    if (repository !== undefined) {
      const refused = await ask({
        token: repository,
        purpose: "provider",
        path: "/v1/responses",
      });
      expect(refused.status).toBe(401);
    }
    expect(
      (
        await ask({
          token: "not-a-token-of-this-installation",
          purpose: "provider",
          path: "/v1/responses",
        })
      ).status,
    ).toBe(401);
  });
});

describe("a session past its budget on /v1/responses", () => {
  test("is refused BUDGET_EXCEEDED once its Responses usage is priced, and its usage lands on the session", async () => {
    gateway = build(0.5);
    const claim = await claimed("openai");
    const call = {
      token: tokenOf(claim),
      purpose: "provider",
      path: "/v1/responses",
    };
    expect((await ask(call)).status).toBe(200);

    const reported = await ask(
      {
        exchange_id: crypto.randomUUID(),
        session_id: claim.session_id,
        attempt_id: claim.attempt_id,
        usage: {
          model: "gpt-5.5-2026-04-23",
          input_tokens: 1_000,
          output_tokens: 100_000,
          cache_creation_input_tokens: 0,
          cache_creation_1h_input_tokens: 0,
          cache_read_input_tokens: 2_000,
          speed: "standard",
          estimated: false,
        },
      },
      EGRESS_USAGE_PATH,
    );
    expect(reported.status).toBe(200);
    // 1000 × $5 + 2000 × $0.50 + 100000 × $30, per million.
    expect(await reported.json()).toEqual({
      cost_usd: 3.006,
      priced_by: "table",
    });

    const refused = await ask(call);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  test("a Claude session's Responses attempt is refused by its connection even before its budget is read", async () => {
    gateway = build(0.5);
    const claim = await claimed("claude");
    expect(
      (
        await ask({
          token: tokenOf(claim),
          purpose: "provider",
          path: "/v1/responses",
        })
      ).status,
    ).toBe(403);
  });
});
