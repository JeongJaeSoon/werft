import { afterEach, describe, expect, test } from "bun:test";
import {
  type FakeResponsesServer,
  quotaError,
  serverError,
  startFakeResponsesServer,
  textResponse,
  toolCallResponse,
} from "./fake-responses.ts";

let server: FakeResponsesServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

function post(
  url: string,
  body: Record<string, unknown> | string,
  headers: Record<string, string> = {},
) {
  return fetch(`${url}/v1/responses`, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

async function events(response: Response) {
  return (await response.text())
    .split("\n\n")
    .filter((block) => block !== "")
    .map((block) => {
      const data = block.split("\n").find((line) => line.startsWith("data: "));
      return JSON.parse(data?.slice(6) ?? "null") as Record<string, unknown>;
    });
}

type Body = { output: [{ content: [{ text: string }] }] } & Record<
  string,
  unknown
>;

describe("fake Responses API", () => {
  test("records the request and answers a non-streaming call as a response object", async () => {
    server = startFakeResponsesServer(textResponse("hello"));
    const response = await post(
      server.url,
      { model: "gpt-5.5", input: "hi" },
      { authorization: "Bearer egress-token" },
    );
    const body = (await response.json()) as Body;

    expect(response.status).toBe(200);
    expect(body.object).toBe("response");
    expect(body.status).toBe("completed");
    expect(body.model).toBe("gpt-5.5");
    expect(body.output[0].content[0]).toMatchObject({
      type: "output_text",
      text: "hello",
    });
    expect(body.usage).toEqual({
      input_tokens: 1,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 4,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 5,
    });
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      path: "/v1/responses",
      body: { model: "gpt-5.5", input: "hi" },
    });
    expect(server.requests[0]?.headers.authorization).toBe(
      "Bearer egress-token",
    );
  });

  test("reports the scripted usage, cached and reasoning shares included", async () => {
    server = startFakeResponsesServer({
      text: "ok",
      usage: {
        input_tokens: 1000,
        output_tokens: 80,
        cached_tokens: 600,
        reasoning_tokens: 30,
      },
    });
    const body = (await (
      await post(server.url, { model: "gpt-5.5" })
    ).json()) as Body;
    expect(body.usage).toMatchObject({
      input_tokens: 1000,
      input_tokens_details: { cached_tokens: 600 },
      output_tokens: 80,
      output_tokens_details: { reasoning_tokens: 30 },
      total_tokens: 1080,
    });
  });

  test("streams a text answer as response.* events ending in response.completed with the usage", async () => {
    server = startFakeResponsesServer({
      text: "hello",
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    const response = await post(server.url, { model: "gpt-5.5", stream: true });
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const seen = await events(response);

    expect(seen.map((event) => event.type)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(seen.map((event) => event.sequence_number)).toEqual([
      0, 1, 2, 3, 4, 5, 6,
    ]);
    expect(seen[3]?.delta).toBe("hello");
    expect(seen.at(-1)).toMatchObject({
      response: {
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 2 },
      },
    });
    // The opening events carry no usage yet, as the API's do not.
    expect(seen[0]).toMatchObject({ response: { usage: null, output: [] } });
  });

  test("streams a tool call, its arguments as one JSON string", async () => {
    server = startFakeResponsesServer(
      toolCallResponse("shell", { command: "ls" }, "call_1"),
    );
    const seen = await events(
      await post(server.url, { model: "gpt-5.5", stream: true }),
    );
    expect(
      seen.find((event) => event.type === "response.output_item.done"),
    ).toMatchObject({
      item: {
        type: "function_call",
        call_id: "call_1",
        name: "shell",
        arguments: '{"command":"ls"}',
      },
    });
    expect(
      seen.find((event) => String(event.type).endsWith("arguments.done")),
    ).toMatchObject({ arguments: '{"command":"ls"}' });
  });

  test("an incomplete reply ends in response.incomplete", async () => {
    server = startFakeResponsesServer({ text: "cut", status: "incomplete" });
    const seen = await events(
      await post(server.url, { model: "gpt-5.5", stream: true }),
    );
    expect(seen.at(-1)).toMatchObject({
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
      },
    });
  });

  test("an array script is consumed in order and its last entry repeats", async () => {
    server = startFakeResponsesServer([
      textResponse("one"),
      textResponse("two"),
    ]);
    const texts: string[] = [];
    for (let call = 0; call < 3; call++) {
      const body = (await (
        await post(server.url, { model: "gpt-5.5" })
      ).json()) as Body;
      texts.push(body.output[0].content[0].text);
    }
    expect(texts).toEqual(["one", "two", "two"]);
  });

  test("a function script sees the request body and its index", async () => {
    server = startFakeResponsesServer((request, index) =>
      textResponse(`${index}:${String(request.body.input)}`),
    );
    const first = (await (
      await post(server.url, { model: "gpt-5.5", input: "a" })
    ).json()) as Body;
    const second = (await (
      await post(server.url, { model: "gpt-5.5", input: "b" })
    ).json()) as Body;
    expect(first.output[0].content[0].text).toBe("0:a");
    expect(second.output[0].content[0].text).toBe("1:b");
  });

  test("injects an OpenAI-shaped error instead of the scripted reply", async () => {
    server = startFakeResponsesServer(textResponse("never"), {
      failWith: quotaError(),
    });
    const response = await post(server.url, { model: "gpt-5.5" });
    expect(response.status).toBe(429);
    expect(response.headers.get("x-request-id")).toStartWith("req_");
    expect(await response.json()).toEqual({
      error: {
        code: "rate_limit_exceeded",
        message: "Rate limit exceeded",
        param: null,
        type: "rate_limit_error",
      },
    });
  });

  test("failWith as a function fails only the requests it names", async () => {
    server = startFakeResponsesServer(textResponse("ok"), {
      failWith: (_request, index) => (index === 0 ? serverError() : undefined),
    });
    expect((await post(server.url, { model: "gpt-5.5" })).status).toBe(500);
    expect((await post(server.url, { model: "gpt-5.5" })).status).toBe(200);
  });

  test("records what else a client contacts, served or not, with the body as it came", async () => {
    server = startFakeResponsesServer(textResponse("ok"));
    const update = await fetch(`${server.url}/telemetry/v1/traces?x=1`, {
      method: "POST",
      body: "not json",
    });
    const models = await fetch(`${server.url}/v1/models`, {
      headers: { "user-agent": "codex/9" },
    });
    expect(update.status).toBe(404);
    expect(models.status).toBe(404);
    // A GET on the served path is not a Responses call either.
    expect((await fetch(`${server.url}/v1/responses`)).status).toBe(404);
    expect(
      server.requests.map(({ method, path, body }) => ({ method, path, body })),
    ).toEqual([
      { method: "POST", path: "/telemetry/v1/traces?x=1", body: "not json" },
      { method: "GET", path: "/v1/models", body: null },
      { method: "GET", path: "/v1/responses", body: null },
    ]);
    expect(server.requests[1]?.headers["user-agent"]).toBe("codex/9");
  });

  test("serves a scripted Response more than once", async () => {
    server = startFakeResponsesServer(
      new Response("teapot", { status: 418, headers: { "x-fake": "1" } }),
    );
    for (let call = 0; call < 2; call++) {
      const response = await post(server.url, { model: "gpt-5.5" });
      expect(response.status).toBe(418);
      expect(await response.text()).toBe("teapot");
    }
  });

  test("a body that is not JSON reaches a function script as an empty request", async () => {
    server = startFakeResponsesServer((request) =>
      textResponse(JSON.stringify(request.body)),
    );
    const body = (await (await post(server.url, "oops")).json()) as Body;
    expect(body.output[0].content[0].text).toBe("{}");
    expect(server.requests[0]?.body).toBe("oops");
  });

  test("an empty array script is refused up front", () => {
    expect(() => startFakeResponsesServer([])).toThrow(
      "Fake Responses reply script must not be empty",
    );
  });
});
