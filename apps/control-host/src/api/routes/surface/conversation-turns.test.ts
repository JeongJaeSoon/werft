import { describe, expect, test } from "bun:test";
import { listConversationTurnsResponseSchema } from "@werft-ai/contracts";
import {
  type ConversationTurnListService,
  InvalidCursorError,
  SessionServiceError,
} from "@werft-ai/platform";
import { recordRouteErrors } from "../../route-error-coverage.ts";
import { registerConversationTurnRoutes } from "./conversation-turns.ts";

const createApiApp = recordRouteErrors(
  "routes/surface/conversation-turns.test.ts",
);

const WORKSPACE = "019a0000-0000-7000-8000-0000000000f2";
const AGENT = "019a0000-0000-7000-8000-0000000000b2";
const owner = { "X-Owner-Id": WORKSPACE };
const path = `/v1/agents/${AGENT}/conversation-turns`;

const PAGE = listConversationTurnsResponseSchema.parse({
  items: [
    {
      id: "019a0000-0000-7000-8000-0000000000c1",
      started_at: "2026-11-24T00:00:00.000Z",
      ended_at: null,
      state: "running" as const,
      limit: null,
      requester: { kind: "slack_user" as const },
      decision: null,
      models: [],
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: "0",
      unpriced_calls: 1,
      slack_thread: null,
      thread_task_session_id: null,
    },
  ],
  next_cursor: "eyJ4IjoxfQ",
});

type List = ConversationTurnListService["listConversationTurns"];

function app(listConversationTurns: List) {
  return createApiApp({
    authMode: "none",
    registerRoutes: (router) =>
      registerConversationTurnRoutes(router, { listConversationTurns }),
  });
}

describe("GET /v1/agents/{id}/conversation-turns", () => {
  test("answers the service's page for the agent and query given", async () => {
    const asked: Parameters<List>[] = [];
    const response = await app(async (...args) => {
      asked.push(args);
      return PAGE;
    }).request(`${path}?limit=2&cursor=abc&initiator=person`, {
      headers: owner,
    });
    expect(response.status).toBe(200);
    expect(
      listConversationTurnsResponseSchema.parse(await response.json()),
    ).toEqual(PAGE);
    expect(asked.map(([, agentId, query]) => [agentId, query])).toEqual([
      [AGENT, { limit: 2, cursor: "abc", initiator: "person" }],
    ]);
  });

  test("defaults to 50 a page and every initiator", async () => {
    const asked: Parameters<List>[2][] = [];
    await app(async (_caller, _agent, query) => {
      asked.push(query);
      return { items: [], next_cursor: null };
    }).request(path, { headers: owner });
    expect(asked).toEqual([{ limit: 50 }]);
  });

  test("refuses a bad query or agent id before the service", async () => {
    let called = false;
    const list: List = async () => {
      called = true;
      return PAGE;
    };
    for (const url of [
      `${path}?initiator=team`,
      `${path}?limit=101`,
      `${path}?limit=0`,
    ]) {
      const response = await app(list).request(url, { headers: owner });
      expect(response.status).toBe(400);
    }
    const response = await app(list).request(
      "/v1/agents/not-a-uuid/conversation-turns",
      { headers: owner },
    );
    expect(response.status).toBe(404);
    expect(called).toBe(false);
  });

  test("keeps the service's refusals: cursor, permission, missing agent, store down", async () => {
    const cursor = await app(async () => {
      throw new InvalidCursorError();
    }).request(`${path}?cursor=forged`, { headers: owner });
    expect(cursor.status).toBe(400);
    for (const [code, status] of [
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["BACKEND_UNAVAILABLE", 503],
    ] as const) {
      const response = await app(async () => {
        throw new SessionServiceError(code, "refused");
      }).request(path, { headers: owner });
      expect(response.status).toBe(status);
    }
  });
});
