import { afterEach, beforeEach, expect, test } from "bun:test";
import type { PGlite } from "@electric-sql/pglite";
import * as schema from "@werft-ai/db";
import {
  createPostgresConversationCalls,
  createPostgresWorkerUnitOfWork,
} from "@werft-ai/db";
import { createLogger } from "@werft-ai/observability";
import {
  createConversationCalls,
  createWorkerGateway,
} from "@werft-ai/platform";
import { acceptAllCheckpoints } from "@werft-ai/platform/testing/checkpoints";
import { migratedPGlite } from "@werft-ai/testkit/pglite";
import { eq } from "drizzle-orm";
import { drizzle, type PgliteDatabase } from "drizzle-orm/pglite";
import { testCatalog } from "../testing/catalog.ts";
import {
  createEgressAuthorizer,
  EGRESS_AUTHORIZER_PATH,
  EGRESS_EXCHANGE_ID_HEADER,
  EGRESS_USAGE_PATH,
} from "./egress-authorizer.ts";

// Built here so no literal reads as a credential.
const BEARER = ["conversation", "call", "authorizer", "bearer"].join("-");
const WORKSPACE = "00000000-0000-4000-8000-0000000000c3";
const MODEL = "claude-haiku-4-5";

let client: PGlite;
let db: PgliteDatabase<typeof schema>;
let authorize: (request: Request) => Promise<Response>;
let issue: ReturnType<typeof createConversationCalls>["issue"];
let agentId: string;
let connectionId: string;

beforeEach(async () => {
  client = await migratedPGlite();
  // The agent and its team alone; their other rows are not under test.
  await client.exec("SET session_replication_role = replica");
  db = drizzle(client, { schema });
  const catalog = testCatalog({
    provider: {
      kind: "anthropic",
      endpoint: "https://api.anthropic.invalid",
      auth: {
        kind: "api_key",
        value: "catalog-provider-key",
        ref: { stored: "connection:test-connection" },
      },
    },
    repositories: {},
  });
  connectionId = Object.keys(catalog.connections)[0] ?? "";
  const store = createPostgresConversationCalls(db as never);
  const gateway = createWorkerGateway({
    work: createPostgresWorkerUnitOfWork(db),
    catalog,
    checkpoints: acceptAllCheckpoints,
    conversationCalls: { store },
    options: {
      sessionBudget: { costUsd: 1_000, tokens: null },
      leaseTtlMs: 60_000,
    },
  });
  authorize = createEgressAuthorizer({
    gateway,
    logger: createLogger({ sinks: [] }),
    token: BEARER,
  });
  issue = createConversationCalls({ store, catalog }).issue;
  const teamId = crypto.randomUUID();
  agentId = crypto.randomUUID();
  await db.insert(schema.memberTeams).values({
    id: teamId,
    workspaceId: WORKSPACE,
    name: "team",
  });
  await db.insert(schema.agents).values({
    id: agentId,
    workspaceId: WORKSPACE,
    managingTeamId: teamId,
    slug: "agent",
    name: "agent",
  });
});

afterEach(async () => {
  await client.close();
});

function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return authorize(
    new Request(`http://authorizer.invalid${path}`, {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
        authorization: `Bearer ${BEARER}`,
      },
      body: JSON.stringify(body),
    }),
  );
}

async function issued() {
  const result = await issue({
    workspaceId: WORKSPACE,
    agentId,
    root: { kind: "user", userId: crypto.randomUUID() },
    connectionId,
    model: MODEL,
    maxTokens: 128,
    maxRequestBytes: 2_048,
  });
  if (result.outcome !== "issued") throw new Error(result.outcome);
  return result;
}

const providerAsk = (token: string, exchangeId?: string) =>
  post(
    EGRESS_AUTHORIZER_PATH,
    { token, purpose: "provider" },
    exchangeId === undefined ? {} : { [EGRESS_EXCHANGE_ID_HEADER]: exchangeId },
  );

const usage = {
  model: MODEL,
  input_tokens: 700,
  output_tokens: 12,
  cache_creation_input_tokens: 0,
  cache_creation_1h_input_tokens: 0,
  cache_read_input_tokens: 0,
  estimated: false,
};

test("a conversation call's token is granted for its exchange, once, and its use settles the call", async () => {
  const call = await issued();
  const exchange = crypto.randomUUID();
  const granted = await providerAsk(call.token, exchange);
  expect(granted.status).toBe(200);
  expect(await granted.json()).toEqual({
    conversation_call_id: call.callId,
    upstream: {
      url: "https://api.anthropic.invalid",
      headers: [["x-api-key", "catalog-provider-key"]],
    },
    request_limits: {
      path: "/v1/messages",
      model: MODEL,
      max_tokens: 128,
      max_request_bytes: 2_048,
    },
  });
  // The proxy's regrant of the same exchange; another exchange is refused.
  expect((await providerAsk(call.token, exchange)).status).toBe(200);
  expect((await providerAsk(call.token, crypto.randomUUID())).status).toBe(401);

  const reported = await post(EGRESS_USAGE_PATH, {
    exchange_id: exchange,
    conversation_call_id: call.callId,
    usage,
  });
  expect(reported.status).toBe(200);
  const answer = (await reported.json()) as {
    cost_usd: number;
    priced_by: string;
  };
  expect(answer.cost_usd).toBeGreaterThan(0);
  const [row] = await db
    .select()
    .from(schema.conversationCalls)
    .where(eq(schema.conversationCalls.id, call.callId));
  expect(row?.state).toBe("settled");
  expect(row?.costUsd).toBe(answer.cost_usd);
  // The same report again is answered the same; from another exchange, 409.
  const again = await post(EGRESS_USAGE_PATH, {
    exchange_id: exchange,
    conversation_call_id: call.callId,
    usage,
  });
  expect(await again.json()).toEqual(answer);
  const other = await post(EGRESS_USAGE_PATH, {
    exchange_id: crypto.randomUUID(),
    conversation_call_id: call.callId,
    usage,
  });
  expect(other.status).toBe(409);
});

test("a proxy that names no exchange gets no grant for a conversation call", async () => {
  const call = await issued();
  expect((await providerAsk(call.token)).status).toBe(401);
  expect((await providerAsk(call.token, "not-a-uuid")).status).toBe(401);
  const [row] = await db
    .select()
    .from(schema.conversationCalls)
    .where(eq(schema.conversationCalls.id, call.callId));
  expect(row?.state).toBe("reserved");
});

test("a usage report for no such call is 404", async () => {
  const reported = await post(EGRESS_USAGE_PATH, {
    exchange_id: crypto.randomUUID(),
    conversation_call_id: crypto.randomUUID(),
    usage,
  });
  expect(reported.status).toBe(404);
});
