import { describe, expect, test } from "bun:test";
import { requestEstimate, usageMeter } from "./usage.ts";

const encoder = new TextEncoder();
const request = encoder.encode(
  JSON.stringify({ model: "claude-sonnet-4-5", max_tokens: 500 }),
);

function metered(contentType: string, chunks: string[]) {
  const meter = usageMeter(contentType);
  for (const chunk of chunks) meter.observe(encoder.encode(chunk));
  return meter.result(request);
}

function sse(events: Array<Record<string, unknown>>): string {
  return events
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");
}

const noTools = {
  speed: "standard",
  inference_geo: "unknown",
  web_search_requests: 0,
  web_fetch_requests: 0,
  code_execution_requests: 0,
};

const started = {
  type: "message_start",
  message: {
    model: "claude-sonnet-4-5",
    content: [],
    usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 40 },
  },
};

describe("usageMeter", () => {
  test("reads a JSON answer's model and usage, split anywhere", () => {
    const body = JSON.stringify({
      type: "message",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "hi" }],
      usage: {
        input_tokens: 12,
        output_tokens: 34,
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 6,
        cache_creation: {
          ephemeral_5m_input_tokens: 3,
          ephemeral_1h_input_tokens: 2,
        },
      },
    });
    expect(
      metered("application/json", [body.slice(0, 20), body.slice(20)]),
    ).toEqual({
      model: "claude-sonnet-4-5",
      input_tokens: 12,
      output_tokens: 34,
      cache_creation_input_tokens: 5,
      cache_read_input_tokens: 6,
      cache_creation_1h_input_tokens: 2,
      ...noTools,
      estimated: false,
    });
  });

  test("takes the input side from message_start and the last message_delta's running totals", () => {
    const stream = sse([
      started,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "hello" },
      },
      { type: "message_delta", delta: {}, usage: { output_tokens: 20 } },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 57, input_tokens: 100 },
      },
      { type: "message_stop" },
    ]);
    // Split mid-line to show lines are rejoined.
    const pieces = [
      stream.slice(0, 7),
      stream.slice(7, 150),
      stream.slice(150),
    ];
    expect(metered("text/event-stream; charset=utf-8", pieces)).toEqual({
      model: "claude-sonnet-4-5",
      input_tokens: 100,
      output_tokens: 57,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 40,
      cache_creation_1h_input_tokens: 0,
      ...noTools,
      estimated: false,
    });
  });

  test("a stream cut before message_stop charges a token per content character it delivered", () => {
    const text = "x".repeat(300);
    const stream = sse([
      started,
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text },
      },
      { type: "message_delta", delta: {}, usage: { output_tokens: 20 } },
    ]);
    expect(metered("text/event-stream", [stream])).toMatchObject({
      input_tokens: 100,
      output_tokens: 300,
      estimated: true,
    });
  });

  test("a JSON answer that says nothing usable is charged from its request", () => {
    const fromRequest = {
      model: "claude-sonnet-4-5",
      input_tokens: request.byteLength,
      output_tokens: 500,
      estimated: true,
    };
    expect(metered("application/json", ['{"id":"msg_1"}'])).toMatchObject(
      fromRequest,
    );
    expect(metered("application/json", ['{"model":"m","usa'])).toMatchObject(
      fromRequest,
    );
    expect(
      metered("application/json", ["x".repeat(9 * 1024 * 1024)]),
    ).toMatchObject(fromRequest);
    expect(
      metered("text/event-stream", [sse([{ type: "ping" }])]),
    ).toMatchObject(fromRequest);
  });

  test("a request that is not JSON is priced as an unknown model", () => {
    expect(requestEstimate(encoder.encode("nope"))).toMatchObject({
      model: "unknown",
      input_tokens: 4,
      output_tokens: 0,
      estimated: true,
    });
  });

  test("a huge content line is skipped without being held, and still counted", () => {
    const big = `data: ${"x".repeat(300 * 1024)}\n\n`;
    const head = sse([started]);
    const tail = sse([{ type: "message_delta", usage: { output_tokens: 3 } }]);
    const result = metered("text/event-stream", [
      head,
      big.slice(0, 1000),
      big.slice(1000),
      tail,
    ]);
    expect(result.estimated).toBe(true);
    expect(result.output_tokens).toBeGreaterThan(300 * 1024);
  });

  describe("speed and server tools", () => {
    const tools = {
      web_search_requests: 2,
      web_fetch_requests: 1,
      code_execution_requests: 3,
    };

    test("a JSON answer's usage.speed and server_tool_use are read", () => {
      const body = JSON.stringify({
        model: "claude-opus-5",
        usage: {
          input_tokens: 1,
          output_tokens: 2,
          speed: "fast",
          server_tool_use: tools,
        },
      });
      expect(metered("application/json", [body])).toMatchObject({
        speed: "fast",
        ...tools,
        estimated: false,
      });
    });

    test("a stream's last message_delta counts win, and message_start's speed stays", () => {
      const stream = sse([
        {
          type: "message_start",
          message: {
            model: "claude-opus-5",
            usage: {
              input_tokens: 5,
              speed: "fast",
              server_tool_use: { web_search_requests: 0 },
            },
          },
        },
        {
          type: "message_delta",
          usage: { output_tokens: 9, server_tool_use: tools, speed: null },
        },
        { type: "message_stop" },
      ]);
      expect(metered("text/event-stream", [stream])).toMatchObject({
        speed: "fast",
        ...tools,
        estimated: false,
      });
    });

    test("an answer that names no speed takes the request's, and a request that names none is standard", () => {
      const answer = JSON.stringify({
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 2 },
      });
      const fastRequest = encoder.encode(
        JSON.stringify({ model: "claude-opus-5", speed: "fast" }),
      );
      const meter = usageMeter("application/json");
      meter.observe(encoder.encode(answer));
      expect(meter.result(fastRequest).speed).toBe("fast");
      expect(metered("application/json", [answer]).speed).toBe("standard");
      expect(requestEstimate(fastRequest)).toMatchObject({
        speed: "fast",
        web_search_requests: 0,
        estimated: true,
      });
    });

    test("the answer's speed wins over the request's", () => {
      const answer = JSON.stringify({
        model: "claude-opus-4-6",
        usage: { input_tokens: 1, output_tokens: 2, speed: "standard" },
      });
      const meter = usageMeter("application/json");
      meter.observe(encoder.encode(answer));
      expect(
        meter.result(encoder.encode(JSON.stringify({ speed: "fast" }))).speed,
      ).toBe("standard");
    });

    test("a speed that is not a name is reported as unknown, never as standard", () => {
      for (const speed of [7, "", "x".repeat(65), { fast: true }]) {
        const answer = JSON.stringify({
          model: "claude-opus-5",
          usage: { input_tokens: 1, output_tokens: 2, speed },
        });
        expect(metered("application/json", [answer]).speed).toBe("unknown");
      }
    });

    test("an answer's usage.inference_geo is read, from a stream's message_start too", () => {
      const answer = JSON.stringify({
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 2, inference_geo: "us" },
      });
      expect(metered("application/json", [answer]).inference_geo).toBe("us");
      const stream = sse([
        {
          type: "message_start",
          message: {
            model: "claude-opus-5",
            usage: { input_tokens: 5, inference_geo: "us" },
          },
        },
        { type: "message_delta", usage: { output_tokens: 9 } },
        { type: "message_stop" },
      ]);
      expect(metered("text/event-stream", [stream])).toMatchObject({
        inference_geo: "us",
        estimated: false,
      });
    });

    test("an answer that names no geo takes the request's, and one that names none is unknown, not global", () => {
      const answer = JSON.stringify({
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 2, inference_geo: null },
      });
      const usRequest = encoder.encode(
        JSON.stringify({ model: "claude-opus-5", inference_geo: "us" }),
      );
      const meter = usageMeter("application/json");
      meter.observe(encoder.encode(answer));
      expect(meter.result(usRequest).inference_geo).toBe("us");
      expect(metered("application/json", [answer]).inference_geo).toBe(
        "unknown",
      );
      expect(requestEstimate(usRequest).inference_geo).toBe("us");
      expect(requestEstimate(null).inference_geo).toBe("unknown");
    });

    test("the answer's geo wins over the request's, and a geo that is not a name is unknown", () => {
      const global = JSON.stringify({
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 2, inference_geo: "global" },
      });
      const meter = usageMeter("application/json");
      meter.observe(encoder.encode(global));
      expect(
        meter.result(encoder.encode(JSON.stringify({ inference_geo: "us" })))
          .inference_geo,
      ).toBe("global");
      for (const inference_geo of [7, "", "x".repeat(65), { us: true }]) {
        const answer = JSON.stringify({
          model: "claude-opus-5",
          usage: { input_tokens: 1, output_tokens: 2, inference_geo },
        });
        expect(metered("application/json", [answer]).inference_geo).toBe(
          "unknown",
        );
      }
    });

    test("a stream cut before its final count charges every search result it delivered", () => {
      const result = (content: unknown) => ({
        type: "content_block_start",
        index: 1,
        content_block: {
          type: "web_search_tool_result",
          tool_use_id: "srvtoolu_1",
          content,
        },
      });
      const stream = sse([
        {
          type: "message_start",
          message: { model: "claude-opus-5", usage: { input_tokens: 5 } },
        },
        result([{ type: "web_search_result", url: "https://a.test" }]),
        result([]),
        result({
          type: "web_search_tool_result_error",
          error_code: "unavailable",
        }),
      ]);
      expect(metered("text/event-stream", [stream])).toMatchObject({
        web_search_requests: 2,
        estimated: true,
      });
    });

    test("a search result too long to parse is still counted, split or whole", () => {
      const huge = sse([
        {
          type: "content_block_start",
          index: 1,
          content_block: {
            type: "web_search_tool_result",
            tool_use_id: "srvtoolu_1",
            content: [
              {
                type: "web_search_result",
                encrypted_content: "x".repeat(300 * 1024),
              },
            ],
          },
        },
      ]);
      const head = sse([
        {
          type: "message_start",
          message: { model: "claude-opus-5", usage: { input_tokens: 5 } },
        },
      ]);
      expect(
        metered("text/event-stream", [head, huge]).web_search_requests,
      ).toBe(1);
      expect(
        metered("text/event-stream", [
          head,
          huge.slice(0, 1000),
          huge.slice(1000, 280 * 1024),
          huge.slice(280 * 1024),
        ]).web_search_requests,
      ).toBe(1);
    });

    test("a stream cut short keeps the tool counts it saw", () => {
      const stream = sse([
        {
          type: "message_start",
          message: { model: "claude-opus-5", usage: { input_tokens: 5 } },
        },
        { type: "message_delta", usage: { server_tool_use: tools } },
      ]);
      expect(metered("text/event-stream", [stream])).toMatchObject({
        ...tools,
        estimated: true,
      });
    });
  });
});

describe("usageMeter on a Responses answer", () => {
  const responsesRequest = encoder.encode(
    JSON.stringify({ model: "gpt-5.5", max_output_tokens: 700, input: "hi" }),
  );
  const meter = (contentType: string, chunks: string[]) => {
    const m = usageMeter(contentType);
    for (const chunk of chunks) m.observe(encoder.encode(chunk));
    return m.result(responsesRequest);
  };
  const usage = {
    input_tokens: 1000,
    output_tokens: 80,
    input_tokens_details: { cached_tokens: 600 },
    output_tokens_details: { reasoning_tokens: 30 },
  };
  const read = {
    model: "gpt-5.5-2026-04-23",
    input_tokens: 400,
    output_tokens: 80,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 600,
    cache_creation_1h_input_tokens: 0,
    ...noTools,
    estimated: false,
  };

  test("a JSON answer moves its cached input to the cache side and keeps the rest as input", () => {
    const body = JSON.stringify({
      object: "response",
      model: "gpt-5.5-2026-04-23",
      usage,
    });
    expect(
      meter("application/json", [body.slice(0, 15), body.slice(15)]),
    ).toEqual(read);
  });

  test("a stream is read from response.completed, whatever came before it", () => {
    const stream = sse([
      { type: "response.created", response: { model: "gpt-5.5-2026-04-23" } },
      { type: "response.output_text.delta", delta: "hello" },
      {
        type: "response.completed",
        response: { model: "gpt-5.5-2026-04-23", usage },
      },
    ]);
    expect(
      meter("text/event-stream", [stream.slice(0, 40), stream.slice(40)]),
    ).toEqual(read);
  });

  test("response.incomplete still carries a full account", () => {
    const stream = sse([
      {
        type: "response.incomplete",
        response: { model: "gpt-5.5", usage },
      },
    ]);
    expect(meter("text/event-stream", [stream])).toMatchObject({
      input_tokens: 400,
      cache_read_input_tokens: 600,
      estimated: false,
    });
  });

  test("an input with no cached share stays whole input", () => {
    const body = JSON.stringify({
      model: "gpt-5.5",
      usage: { input_tokens: 50, output_tokens: 5 },
    });
    expect(meter("application/json", [body])).toMatchObject({
      input_tokens: 50,
      cache_read_input_tokens: 0,
      estimated: false,
    });
  });

  test("a stream cut before response.completed charges a token per character delivered", () => {
    const stream = sse([
      { type: "response.created", response: { model: "gpt-5.5" } },
      { type: "response.output_text.delta", delta: "x".repeat(900) },
    ]);
    // More than the 700 the request allowed: the larger count is charged.
    expect(meter("text/event-stream", [stream])).toMatchObject({
      model: "gpt-5.5",
      output_tokens: 900,
      estimated: true,
    });
  });

  test("a completed response that names no usage is estimated, not charged nothing", () => {
    const stream = sse([
      { type: "response.output_text.delta", delta: "x".repeat(900) },
      { type: "response.completed", response: { model: "gpt-5.5" } },
    ]);
    expect(meter("text/event-stream", [stream])).toMatchObject({
      output_tokens: 900,
      estimated: true,
    });
  });

  test("a failed response is estimated even when it reports usage", () => {
    const stream = sse([
      {
        type: "response.failed",
        response: { model: "gpt-5.5", usage },
      },
    ]);
    expect(meter("text/event-stream", [stream])).toMatchObject({
      estimated: true,
    });
  });

  test("a JSON answer with no usage is charged from its request, bounded by max_output_tokens", () => {
    expect(meter("application/json", ['{"error":{}}'])).toMatchObject({
      model: "gpt-5.5",
      input_tokens: responsesRequest.byteLength,
      output_tokens: 700,
      estimated: true,
    });
    expect(requestEstimate(responsesRequest)).toMatchObject({
      output_tokens: 700,
    });
  });

  test("a stream cut before response.completed is charged what the request allowed", () => {
    const stream = sse([
      { type: "response.created", response: { model: "gpt-5.5" } },
      { type: "response.output_text.delta", delta: "hel" },
    ]);
    expect(meter("text/event-stream", [stream])).toMatchObject({
      model: "gpt-5.5",
      input_tokens: responsesRequest.byteLength,
      output_tokens: 700,
      estimated: true,
    });
  });

  test("cache writes come out of the input and the 12-hour ones ride the one-hour slot", () => {
    const body = JSON.stringify({
      model: "gpt-6.1-sol",
      usage: {
        input_tokens: 1000,
        output_tokens: 10,
        input_tokens_details: {
          cached_tokens: 100,
          cache_write_tokens: 300,
          cache_write_tokens_details: {
            ttl_30m_tokens: 200,
            ttl_12h_tokens: 100,
          },
        },
      },
    });
    expect(meter("application/json", [body])).toMatchObject({
      input_tokens: 600,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 300,
      cache_creation_1h_input_tokens: 100,
      estimated: false,
    });
  });

  test("a cut stream of a request with no output cap is charged a fixed allowance", () => {
    const uncapped = usageMeter("text/event-stream");
    uncapped.observe(
      encoder.encode(
        sse([{ type: "response.created", response: { model: "gpt-5.5" } }]),
      ),
    );
    expect(
      uncapped.result(encoder.encode(JSON.stringify({ model: "gpt-5.5" }))),
    ).toMatchObject({ output_tokens: 32_768, estimated: true });
  });

  test("a search finished before the stream was cut is still counted", () => {
    const stream = sse([
      { type: "response.created", response: { model: "gpt-5.5" } },
      {
        type: "response.output_item.done",
        item: { type: "web_search_call", status: "completed" },
      },
      {
        type: "response.output_item.done",
        item: { type: "web_search_call", status: "failed" },
      },
    ]);
    expect(meter("text/event-stream", [stream])).toMatchObject({
      web_search_requests: 1,
      estimated: true,
    });
  });

  test("the tier a stream announces in response.created prices a cut stream, whatever the request said", () => {
    const stream = sse([
      {
        type: "response.created",
        response: { model: "gpt-5.5", service_tier: "priority" },
      },
    ]);
    expect(meter("text/event-stream", [stream])).toMatchObject({
      speed: "fast",
    });
  });

  test("a tier that is not standard or fast is reported under its own name, flex and auto as standard", () => {
    const tier = (service_tier: string) =>
      meter("application/json", [
        JSON.stringify({ model: "gpt-5.5", service_tier, usage }),
      ]).speed;
    expect(tier("ultrafast")).toBe("ultrafast");
    expect(tier("flex")).toBe("standard");
    expect(tier("auto")).toBe("standard");
    expect(tier("default")).toBe("standard");
  });

  test("a priority or fast service_tier is the fast speed, in JSON and in a stream", () => {
    const answer = { model: "gpt-5.5", service_tier: "priority", usage };
    expect(meter("application/json", [JSON.stringify(answer)])).toMatchObject({
      speed: "fast",
    });
    expect(
      meter("text/event-stream", [
        sse([{ type: "response.completed", response: answer }]),
      ]),
    ).toMatchObject({ speed: "fast" });
    expect(
      meter("application/json", [
        JSON.stringify({ ...answer, service_tier: "default" }),
      ]),
    ).toMatchObject({ speed: "standard" });
  });

  test("a request for the fast tier is estimated at the fast speed", () => {
    expect(
      requestEstimate(
        encoder.encode(
          JSON.stringify({ model: "gpt-5.5", service_tier: "fast" }),
        ),
      ),
    ).toMatchObject({ speed: "fast" });
  });

  test("each web_search_call that did not fail is a search", () => {
    const output = [
      { type: "web_search_call", status: "completed" },
      { type: "web_search_call", status: "failed" },
      { type: "web_search_call", status: "completed" },
      { type: "message" },
    ];
    expect(
      meter("application/json", [
        JSON.stringify({ model: "gpt-5.5", usage, output }),
      ]),
    ).toMatchObject({ web_search_requests: 2 });
    expect(
      meter("text/event-stream", [
        sse([
          {
            type: "response.completed",
            response: { model: "gpt-5.5", usage, output },
          },
        ]),
      ]),
    ).toMatchObject({ web_search_requests: 2 });
  });
});
