import { describe, expect, test } from "bun:test";
import type {
  SlackInteractionOutcome,
  SlackInteractionService,
} from "@werft-ai/chat-slack";
import { slackInteractionResponseSchema } from "@werft-ai/contracts";
import { createSlackEventsLimiter } from "../rate-limit.ts";
import { recordRouteErrors } from "../route-error-coverage.ts";
import { registerSlackInteractionRoutes } from "./slack-interactions.ts";

const createApiApp = recordRouteErrors("routes/slack-interactions.test.ts");

const AGENT = "019a0000-0000-7000-8000-0000000000c1";

type Received = Parameters<SlackInteractionService["receive"]>[0];

function appWith(
  receive: (request: Received) => Promise<SlackInteractionOutcome>,
  limiter = createSlackEventsLimiter(),
) {
  const app = createApiApp({
    authMode: "api-key",
    registerPublicRoutes: (router) =>
      registerSlackInteractionRoutes(router, {
        interactions: { receive },
        limiter,
      }),
  });
  return async (body: string, headers: Record<string, string> = {}) => {
    const response = await app.request(`/v1/slack/interactions/${AGENT}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body,
    });
    const text = await response.text();
    return {
      status: response.status,
      json: text ? JSON.parse(text) : null,
      headers: response.headers,
    };
  };
}

const answered = async (): Promise<SlackInteractionOutcome> => ({
  kind: "ok",
  body: { ok: true },
  result: "answered",
});

describe("POST /v1/slack/interactions/{agent_id}", () => {
  test("hands the raw form and Slack's headers to the service and answers its body", async () => {
    const seen: Received[] = [];
    const post = appWith(async (request) => {
      seen.push(request);
      return { kind: "ok", body: { response_action: "clear" }, result: "x" };
    });
    const body = "payload=%7B%22type%22%3A%22view_submission%22%7D";
    const response = await post(body, {
      "X-Slack-Request-Timestamp": "1761300000",
      "X-Slack-Signature": "v0=abc",
    });
    expect(response.status).toBe(200);
    expect(slackInteractionResponseSchema.parse(response.json)).toEqual({
      response_action: "clear",
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.agentId).toBe(AGENT);
    expect(new TextDecoder().decode(seen[0]?.rawBody)).toBe(body);
    expect([seen[0]?.timestamp, seen[0]?.signature]).toEqual([
      "1761300000",
      "v0=abc",
    ]);
  });

  test("an unsigned request is 401 and a malformed one 400", async () => {
    expect(
      (await appWith(async () => ({ kind: "unauthorized" }))("payload=x"))
        .status,
    ).toBe(401);
    expect(
      (await appWith(async () => ({ kind: "bad_request" }))("payload=x"))
        .status,
    ).toBe(400);
  });

  test("a body over 256 KiB is refused before the service runs", async () => {
    let calls = 0;
    const post = appWith(async () => {
      calls += 1;
      return answered();
    });
    const huge = await post(`payload=${"x".repeat(256 * 1024)}`);
    expect(huge.status).toBe(413);
    expect(calls).toBe(0);
  });

  test("the limiter answers 429 before the service runs", async () => {
    let calls = 0;
    const post = appWith(
      async () => {
        calls += 1;
        return answered();
      },
      createSlackEventsLimiter({ globalPerMinute: 1000, agentPerMinute: 1 }),
    );
    expect((await post("payload=x")).status).toBe(200);
    const over = await post("payload=x");
    expect(over.status).toBe(429);
    expect(over.headers.get("Retry-After")).not.toBeNull();
    expect(calls).toBe(1);
  });

  test("a storage failure answers 503 so Slack's retry can land", async () => {
    const post = appWith(async () => {
      throw Object.assign(new Error("canceling statement"), { code: "57014" });
    });
    expect((await post("payload=x")).status).toBe(503);
  });
});
