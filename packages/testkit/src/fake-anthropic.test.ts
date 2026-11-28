import { afterEach, describe, expect, test } from "bun:test";
import {
  type FakeAnthropicServer,
  overloadedError,
  quotaError,
  startFakeAnthropicServer,
  textReply,
  toolReply,
} from "./fake-anthropic.ts";

let server: FakeAnthropicServer | undefined;

afterEach(() => {
  server?.stop();
  server = undefined;
});

async function postMessages(
  url: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return fetch(`${url}/v1/messages?beta=true`, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });
}

describe("fake Anthropic Messages API", () => {
  test("records requests and answers a non-streaming call as JSON", async () => {
    server = startFakeAnthropicServer(textReply("hello"));
    const response = await postMessages(
      server.url,
      { model: "claude-sonnet-4-5", messages: [] },
      { "x-api-key": "placeholder-local" },
    );
    const message = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(response.headers.get("request-id")).toStartWith("req_");
    expect(message.model).toBe("claude-sonnet-4-5");
    expect(message.stop_reason).toBe("end_turn");
    expect(message.content).toEqual([{ type: "text", text: "hello" }]);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]?.path).toBe("/v1/messages?beta=true");
    expect(server.requests[0]?.headers["x-api-key"]).toBe("placeholder-local");
    expect(server.requests[0]?.body.model).toBe("claude-sonnet-4-5");
  });

  test("streams every block as SSE when the request asks for a stream", async () => {
    server = startFakeAnthropicServer(
      toolReply("Bash", { command: "ls" }, "toolu_1"),
    );
    const response = await postMessages(server.url, {
      model: "claude-sonnet-4-5",
      stream: true,
      messages: [],
    });
    const text = await response.text();
    const eventTypes = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(eventTypes).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(text).toContain('"partial_json":"{\\"command\\":\\"ls\\"}"');
    expect(text).toContain('"stop_reason":"tool_use"');
  });

  test("a reply whose usage is empty names no token count, in JSON and in a stream", async () => {
    server = startFakeAnthropicServer({ ...textReply("hi"), usage: {} });
    const body = { model: "claude-sonnet-4-5", messages: [] };
    const json = (await (await postMessages(server.url, body)).json()) as {
      usage: Record<string, unknown>;
    };
    expect(json.usage).toEqual({ inference_geo: "global" });
    const stream = await (
      await postMessages(server.url, { ...body, stream: true })
    ).text();
    const usages = [...stream.matchAll(/^data: (.+)$/gm)]
      .map((m) => JSON.parse(m[1] ?? "{}") as Record<string, unknown>)
      .flatMap((event) =>
        event.type === "message_start"
          ? [(event.message as { usage: unknown }).usage]
          : event.type === "message_delta"
            ? [event.usage]
            : [],
      );
    expect(usages).toEqual([{ inference_geo: "global" }, {}]);
  });

  test("answers the auto mode safety check only when the request asks for it", async () => {
    server = startFakeAnthropicServer([
      toolReply("Bash", { command: "ls" }, "toolu_1"),
      { ...toolReply("Bash", { command: "ls" }, "toolu_2"), flagged: true },
      toolReply("Bash", { command: "ls" }, "toolu_3"),
    ]);
    const asked = { model: "claude-sonnet-4-5", messages: [], safeguards: {} };
    const verdict = (id: string, outcome: string) => [
      {
        type: "dangerous_tool_use",
        status: {
          type: "available",
          tool_uses: { [id]: { type: "evaluated", outcome } },
        },
      },
    ];

    const allowed = (await (
      await postMessages(server.url, asked)
    ).json()) as Record<string, unknown>;
    expect(allowed.safeguard_results).toEqual(
      verdict("toolu_1", "not_flagged"),
    );

    const streamed = await (
      await postMessages(server.url, { ...asked, stream: true })
    ).text();
    const delta = [...streamed.matchAll(/^data: (.+)$/gm)]
      .map((m) => JSON.parse(m[1] as string) as Record<string, unknown>)
      .find((event) => event.type === "message_delta") as {
      delta: Record<string, unknown>;
    };
    expect(delta.delta.safeguard_results).toEqual(
      verdict("toolu_2", "flagged"),
    );

    const plain = (await (
      await postMessages(server.url, {
        model: "claude-sonnet-4-5",
        messages: [],
      })
    ).json()) as Record<string, unknown>;
    expect("safeguard_results" in plain).toBe(false);
  });

  test("plays an array script in order and repeats the last entry", async () => {
    server = startFakeAnthropicServer([textReply("one"), textReply("two")]);
    const texts: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const response = await postMessages(server.url, { messages: [] });
      const message = (await response.json()) as {
        content: Array<{ text: string }>;
      };
      texts.push(message.content[0]?.text ?? "");
    }
    expect(texts).toEqual(["one", "two", "two"]);
  });

  test("serves a scripted Response object more than once", async () => {
    server = startFakeAnthropicServer([
      Response.json({ custom: true }, { status: 418 }),
    ]);
    const first = await postMessages(server.url, { messages: [] });
    const second = await postMessages(server.url, { messages: [] });
    expect([first.status, second.status]).toEqual([418, 418]);
    expect(await first.json()).toEqual({ custom: true });
    expect(await second.json()).toEqual({ custom: true });
  });

  test("passes the recorded request and index to a resolver", async () => {
    server = startFakeAnthropicServer((request, index) =>
      textReply(`${request.body.model}-${index}`),
    );
    await postMessages(server.url, { model: "a", messages: [] });
    const second = await postMessages(server.url, { model: "b", messages: [] });
    const message = (await second.json()) as {
      content: Array<{ text: string }>;
    };
    expect(message.content[0]?.text).toBe("b-1");
  });

  test("injects latency and Anthropic-shaped failures", async () => {
    server = startFakeAnthropicServer(textReply("never"), {
      failWith: (_request, index) =>
        index === 0
          ? quotaError()
          : index === 1
            ? overloadedError()
            : undefined,
      latencyMs: 50,
    });
    const { url } = server;
    const elapsed: number[] = [];
    const timed = async () => {
      const started = performance.now();
      const response = await postMessages(url, { messages: [] });
      elapsed.push(performance.now() - started);
      return response;
    };
    const quota = await timed();
    const overloaded = await timed();
    const ok = await timed();

    // Bun.sleep has millisecond granularity and can wake up to 1ms before
    // performance.now says the full delay passed.
    for (const ms of elapsed) expect(ms).toBeGreaterThanOrEqual(49);
    expect(quota.status).toBe(429);
    expect(await quota.json()).toEqual({
      type: "error",
      error: { type: "rate_limit_error", message: "Rate limit exceeded" },
    });
    expect(overloaded.status).toBe(529);
    expect(ok.status).toBe(200);
    expect(server.requests).toHaveLength(3);
  });

  test("returns 404 for anything but POST /messages and GET /v1/models", async () => {
    server = startFakeAnthropicServer(textReply("x"));
    for (const [method, path] of [
      ["GET", "/v1/files"],
      ["POST", "/v1/models"],
      ["GET", "/v1/messages"],
    ] as const) {
      const response = await fetch(`${server.url}${path}`, { method });
      expect(response.status).toBe(404);
    }
    expect(server.requests).toHaveLength(0);
  });

  test("lists its models page by page, as Anthropic does, without recording a call", async () => {
    server = startFakeAnthropicServer(textReply("x"));
    const first = await fetch(`${server.url}/v1/models?limit=3`);
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      data: Array<{ id: string; display_name: string; type: string }>;
      has_more: boolean;
      last_id: string;
    };
    expect(page.data.map((model) => model.id)).toEqual([
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-5",
    ]);
    expect(page.data[0]?.display_name).toBe("Claude Sonnet 5");
    expect(page.has_more).toBe(true);
    const rest = (await (
      await fetch(`${server.url}/v1/models?limit=3&after_id=${page.last_id}`)
    ).json()) as { data: Array<{ id: string }>; has_more: boolean };
    expect(rest.data.map((model) => model.id)).toEqual(["claude-sonnet-4-5"]);
    expect(rest.has_more).toBe(false);
    expect(server.requests).toHaveLength(0);
  });

  test("lists the models it is given", async () => {
    server = startFakeAnthropicServer(textReply("x"), {
      models: [{ id: "only-one", display_name: "Only One" }],
    });
    const listed = (await (await fetch(`${server.url}/v1/models`)).json()) as {
      data: Array<{ id: string }>;
    };
    expect(listed.data.map((model) => model.id)).toEqual(["only-one"]);
  });
});
