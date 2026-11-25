import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SlackEventsService } from "@werft-ai/chat-slack";
import { createLogger } from "@werft-ai/observability";
import { ambiguousPathGuard } from "./ambiguous-path.ts";
import {
  createSlackEventResponses,
  SLACK_EVENT_RESPONSES_METRIC,
  serveApiMetrics,
} from "./api-metrics.ts";
import { createApiApp } from "./app.ts";
import { serveApiApp } from "./listeners.ts";
import { createSlackEventsLimiter } from "./rate-limit.ts";
import { registerSlackEventRoutes } from "./routes/surface/slack-events.ts";

const AGENT = "019a0000-0000-7000-8000-0000000000c1";
const logger = createLogger({ level: "error" });

const servers: { stop(close?: boolean): unknown }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});
const dist = await mkdtemp(join(tmpdir(), "api-metrics-dist-"));
await writeFile(join(dist, "index.html"), "<!doctype html><p>console</p>");
afterAll(() => rm(dist, { recursive: true, force: true }));

const sample = (text: string, code: string) =>
  text
    .split("\n")
    .find((line) =>
      line.startsWith(`${SLACK_EVENT_RESPONSES_METRIC}{code="${code}"} `),
    )
    ?.split(" ")[1];

describe("the Slack event response counter", () => {
  test("every code has a series from the start", () => {
    const text = createSlackEventResponses().render();
    expect(text).toContain(`# TYPE ${SLACK_EVENT_RESPONSES_METRIC} counter`);
    for (const code of ["200", "503", "500", "other"]) {
      expect(sample(text, code)).toBe("0");
    }
  });

  test("a status outside the fixed set is counted as other", () => {
    const responses = createSlackEventResponses();
    for (const status of [200, 200, 503, 500, 418, 302]) {
      responses.count(status);
    }
    const text = responses.render();
    expect(sample(text, "200")).toBe("2");
    expect(sample(text, "503")).toBe("1");
    expect(sample(text, "500")).toBe("1");
    expect(sample(text, "other")).toBe("2");
    expect(text).not.toContain('code="418"');
  });
});

describe("the Slack events route counts what it answers", () => {
  function post(receive: SlackEventsService["receive"], deadlineMs?: number) {
    const responses = createSlackEventResponses();
    const app = createApiApp({
      authMode: "api-key",
      logger,
      slackEventResponses: responses,
      ...(deadlineMs === undefined ? {} : { requestDeadlineMs: deadlineMs }),
      registerPublicRoutes: (router) =>
        registerSlackEventRoutes(router, {
          events: { receive },
          limiter: createSlackEventsLimiter(),
        }),
    });
    return {
      responses,
      send: async () =>
        (
          await app.request(`/v1/slack/events/${AGENT}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
    };
  }

  test.each([
    ["200", async () => ({ kind: "ack", result: "inserted" }) as const],
    ["503", async () => ({ kind: "unavailable", step: "record" }) as const],
    ["401", async () => ({ kind: "unauthorized" }) as const],
    [
      "500",
      async () => {
        throw new Error("boom");
      },
    ],
  ] as const)("%s", async (code, receive) => {
    const { responses, send } = post(
      receive as unknown as SlackEventsService["receive"],
    );
    expect(String(await send())).toBe(code);
    expect(sample(responses.render(), code)).toBe("1");
  });

  test("only Slack's POST to the events URL is counted", async () => {
    const responses = createSlackEventResponses();
    const app = createApiApp({
      authMode: "api-key",
      logger,
      slackEventResponses: responses,
      registerPublicRoutes: (router) =>
        registerSlackEventRoutes(router, {
          events: { receive: async () => ({ kind: "unauthorized" }) },
          limiter: createSlackEventsLimiter(),
        }),
    });
    for (const method of ["GET", "HEAD", "PUT", "OPTIONS"]) {
      await app.request(`/v1/slack/events/${AGENT}`, { method });
    }
    await app.request(`/v1/slack/events/${AGENT}/extra`, {
      method: "POST",
      body: "{}",
    });
    await app.request("/v1/slack/events", { method: "POST", body: "{}" });
    expect(responses.render()).not.toMatch(/} [1-9]/);
  });

  test("the request deadline's 503 is counted too", async () => {
    const { responses, send } = post(() => new Promise(() => {}), 50);
    expect(await send()).toBe(503);
    expect(sample(responses.render(), "503")).toBe("1");
  });
});

describe("the api's /metrics listener", () => {
  test("is off when METRICS_PORT is unset", () => {
    expect(
      serveApiMetrics({}, createSlackEventResponses(), logger),
    ).toBeUndefined();
    expect(
      serveApiMetrics(
        { METRICS_PORT: "" },
        createSlackEventResponses(),
        logger,
      ),
    ).toBeUndefined();
  });

  test("serves the counter on METRICS_PORT", async () => {
    const responses = createSlackEventResponses();
    responses.count(503);
    const server = serveApiMetrics(
      { METRICS_PORT: "0" },
      responses,
      logger,
      "127.0.0.1",
    );
    if (server === undefined) throw new Error("no metrics listener");
    servers.push(server);
    const answer = await fetch(`http://127.0.0.1:${server.port}/metrics`);
    expect(answer.status).toBe(200);
    expect(answer.headers.get("content-type")).toContain("version=0.0.4");
    expect(sample(await answer.text(), "503")).toBe("1");
    const health = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(health.status).toBe(200);
  });

  test("the public listener answers /metrics with the API's 404", async () => {
    const guard = ambiguousPathGuard({ warn: () => undefined });
    const publicServer = serveApiApp(
      createApiApp({
        authMode: "api-key",
        webDistDir: dist,
        slackEventResponses: createSlackEventResponses(),
      }),
      { listener: "api", port: 0, hostname: "127.0.0.1", guard },
    );
    servers.push(publicServer);
    const answer = await fetch(`http://127.0.0.1:${publicServer.port}/metrics`);
    expect(answer.status).toBe(404);
    expect(await answer.text()).not.toContain(SLACK_EVENT_RESPONSES_METRIC);
  });
});
