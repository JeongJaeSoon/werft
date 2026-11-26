/**
 * Local stand-in for the Anthropic Messages API. Speaks both the streaming
 * (SSE) and non-streaming shapes so the Claude Agent SDK, LiteLLM and plain
 * fetch callers can all be pointed at it without a paid model call.
 */

export type AnthropicRequest = {
  messages?: unknown[];
  model?: string;
  stream?: boolean;
  system?: unknown;
  tools?: unknown[];
} & Record<string, unknown>;

export type FakeBlock =
  | { text: string; type: "text" }
  | {
      id: string;
      input: Record<string, unknown>;
      name: string;
      type: "tool_use";
    };

export type FakeReply = {
  content: FakeBlock[];
  stopReason: "end_turn" | "tool_use";
  /** Token counts to report, which is how a test makes a reply cost something. */
  usage?: { input_tokens: number; output_tokens: number };
  /** The auto mode safety check flags this reply's tool calls. */
  flagged?: boolean;
};

export type RecordedRequest = {
  body: AnthropicRequest;
  headers: Record<string, string>;
  path: string;
  signal: AbortSignal;
};

export type FakeFailure = {
  message?: string;
  status: number;
  type?: string;
};

export type ReplyResolver = (
  request: RecordedRequest,
  index: number,
) => FakeReply | Response | Promise<FakeReply | Response>;

/**
 * A single reply repeats for every request; an array is consumed in order and
 * its last entry repeats once exhausted; a function decides per request.
 */
export type ReplyScript =
  | FakeReply
  | Response
  | ReadonlyArray<FakeReply | Response>
  | ReplyResolver;

export type FakeAnthropicOptions = {
  /** Inject an Anthropic-style error response instead of the scripted reply. */
  failWith?:
    | FakeFailure
    | ((request: RecordedRequest, index: number) => FakeFailure | undefined);
  /** Delay before every response, applied before `failWith` and the reply. */
  latencyMs?: number;
  /**
   * Serve HTTPS with this certificate, so a client that tunnels TLS through
   * a proxy (`CONNECT`) exercises that path instead of absolute-form HTTP.
   */
  tls?: { cert: string; key: string };
  /** Where to listen; loopback on a free port unless a long-running host says otherwise. */
  listen?: { hostname: string; port: number };
  /** What `GET /v1/models` lists, in order; `FAKE_ANTHROPIC_MODELS` by default. */
  models?: ReadonlyArray<{ id: string; display_name: string }>;
  /** The most models one page holds, whatever `limit` asks for. */
  modelsPageMax?: number;
  /**
   * How many of the latest requests `requests` and `modelRequests` each
   * hold, oldest out first; all by default. A long-running host sets it, as
   * every request carries its whole conversation.
   */
  keepRequests?: number;
};

export type FakeAnthropicServer = {
  requests: RecordedRequest[];
  /** Every `GET /v1/models`: path with query, and headers. */
  modelRequests: { path: string; headers: Record<string, string> }[];
  stop(): void;
  url: string;
};

const defaultModel = "claude-sonnet-4-5";

export const FAKE_ANTHROPIC_MODELS = [
  { id: "claude-sonnet-5", display_name: "Claude Sonnet 5" },
  { id: "claude-opus-5", display_name: "Claude Opus 5" },
  { id: "claude-haiku-5", display_name: "Claude Haiku 5" },
  { id: "claude-sonnet-4-5", display_name: "Claude Sonnet 4.5" },
] as const;

/**
 * Anthropic's model list: `limit` per page (20 when not given), the page
 * after `after_id`, `has_more` and the page's first and last ids.
 */
function modelsPage(
  models: ReadonlyArray<{ id: string; display_name: string }>,
  url: URL,
  pageMax: number,
): Response {
  const limit = Math.min(
    Number(url.searchParams.get("limit") ?? "20"),
    pageMax,
  );
  const after = url.searchParams.get("after_id");
  const start =
    after === null ? 0 : models.findIndex((model) => model.id === after) + 1;
  const page = models.slice(start, start + limit);
  return Response.json({
    data: page.map((model) => ({
      type: "model",
      id: model.id,
      display_name: model.display_name,
      created_at: "2026-01-01T00:00:00Z",
    })),
    has_more: start + limit < models.length,
    first_id: page[0]?.id ?? null,
    last_id: page.at(-1)?.id ?? null,
  });
}

export function startFakeAnthropicServer(
  replies: ReplyScript,
  options: FakeAnthropicOptions = {},
): FakeAnthropicServer {
  const requests: RecordedRequest[] = [];
  const modelRequests: FakeAnthropicServer["modelRequests"] = [];
  const resolve = toResolver(replies);
  const keep = options.keepRequests ?? Number.POSITIVE_INFINITY;
  const trim = (log: unknown[]) => {
    if (log.length > keep) log.splice(0, log.length - keep);
  };
  let received = 0;
  const server = Bun.serve({
    hostname: options.listen?.hostname ?? "127.0.0.1",
    port: options.listen?.port ?? 0,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/models") {
        modelRequests.push({
          path: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(request.headers.entries()),
        });
        trim(modelRequests);
        return modelsPage(
          options.models ?? FAKE_ANTHROPIC_MODELS,
          url,
          options.modelsPageMax ?? 1000,
        );
      }
      if (request.method !== "POST" || !url.pathname.endsWith("/messages")) {
        return new Response("not found", { status: 404 });
      }
      const recorded: RecordedRequest = {
        body: (await request.json()) as AnthropicRequest,
        headers: Object.fromEntries(request.headers.entries()),
        path: `${url.pathname}${url.search}`,
        signal: request.signal,
      };
      const index = received++;
      requests.push(recorded);
      trim(requests);
      if (options.latencyMs !== undefined && options.latencyMs > 0) {
        await Bun.sleep(options.latencyMs);
      }
      const failure =
        typeof options.failWith === "function"
          ? options.failWith(recorded, index)
          : options.failWith;
      if (failure !== undefined) return errorResponse(failure);
      const reply = await resolve(recorded, index);
      if (reply instanceof Response) return reusable(reply);
      return anthropicResponse(
        recorded.body.model ?? defaultModel,
        reply,
        recorded.body.stream === true,
        recorded.body.safeguards !== undefined,
      );
    },
  });
  return {
    requests,
    modelRequests,
    stop: () => server.stop(true),
    url: `${options.tls === undefined ? "http" : "https"}://${options.listen?.hostname ?? "127.0.0.1"}:${server.port}`,
  };
}

export function textReply(text: string): FakeReply {
  return { content: [{ type: "text", text }], stopReason: "end_turn" };
}

export function toolReply(
  name: string,
  input: Record<string, unknown>,
  id = `toolu_${crypto.randomUUID()}`,
): FakeReply {
  return toolsReply([{ id, input, name }]);
}

export function toolsReply(
  tools: Array<{ id: string; input: Record<string, unknown>; name: string }>,
): FakeReply {
  return {
    content: tools.map(({ id, input, name }) => ({
      type: "tool_use" as const,
      id,
      input,
      name,
    })),
    stopReason: "tool_use",
  };
}

export function serverError(status = 500, message = "Internal server error") {
  return { message, status, type: "api_error" } satisfies FakeFailure;
}

export function overloadedError(message = "Overloaded") {
  return {
    message,
    status: 529,
    type: "overloaded_error",
  } satisfies FakeFailure;
}

export function quotaError(message = "Rate limit exceeded") {
  return {
    message,
    status: 429,
    type: "rate_limit_error",
  } satisfies FakeFailure;
}

export function errorResponse(failure: FakeFailure): Response {
  return Response.json(
    {
      type: "error",
      error: {
        type: failure.type ?? "api_error",
        message: failure.message ?? `HTTP ${failure.status}`,
      },
    },
    {
      status: failure.status,
      headers: { "request-id": `req_${crypto.randomUUID()}` },
    },
  );
}

// A scripted Response may be served more than once, so hand out a copy and
// keep the original body unread.
export function reusable(response: Response): Response {
  const copy = response.clone();
  return new Response(copy.body, {
    headers: copy.headers,
    status: copy.status,
    statusText: copy.statusText,
  });
}

function toResolver(replies: ReplyScript): ReplyResolver {
  if (typeof replies === "function") return replies;
  if (Array.isArray(replies)) {
    const script = replies as ReadonlyArray<FakeReply | Response>;
    if (script.length === 0) {
      throw new Error("Fake Anthropic reply script must not be empty");
    }
    return (_request, index) =>
      script[Math.min(index, script.length - 1)] as FakeReply | Response;
  }
  return () => replies as FakeReply | Response;
}

/**
 * The auto mode safety check's verdict, allowing every tool call. The Claude
 * engine in auto mode asks the API to run the check with a top-level
 * `safeguards` field and reads this from the reply (the pinned CLI's gateway
 * notes); a reply without it makes the engine refuse the calls the check
 * would judge.
 */
function allowAllSafeguards(reply: FakeReply) {
  return [
    {
      type: "dangerous_tool_use",
      status: {
        type: "available",
        tool_uses: Object.fromEntries(
          reply.content.flatMap((block) =>
            block.type === "tool_use"
              ? [
                  [
                    block.id,
                    {
                      type: "evaluated",
                      outcome:
                        reply.flagged === true ? "flagged" : "not_flagged",
                    },
                  ],
                ]
              : [],
          ),
        ),
      },
    },
  ];
}

function anthropicResponse(
  model: string,
  reply: FakeReply,
  stream: boolean,
  safeguards: boolean,
): Response {
  const verdict = safeguards
    ? { safeguard_results: allowAllSafeguards(reply) }
    : {};
  const message = {
    id: `msg_${crypto.randomUUID()}`,
    type: "message",
    role: "assistant",
    model,
    content: reply.content,
    stop_reason: reply.stopReason,
    stop_sequence: null,
    // The API always says where it ran; the egress proxy prices a call that
    // does not say at the highest rate.
    usage: {
      inference_geo: "global",
      ...(reply.usage ?? { input_tokens: 1, output_tokens: 4 }),
    },
  };
  const requestId = `req_${crypto.randomUUID()}`;
  if (!stream) {
    return Response.json(
      { ...message, ...verdict },
      { headers: { "request-id": requestId } },
    );
  }

  const events: Array<Record<string, unknown>> = [
    {
      type: "message_start",
      message: { ...message, content: [], stop_reason: null },
    },
  ];
  for (const [index, block] of reply.content.entries()) {
    if (block.type === "text") {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index,
          delta: { type: "text_delta", text: block.text },
        },
      );
    } else {
      events.push(
        {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        },
        {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(block.input),
          },
        },
      );
    }
    events.push({ type: "content_block_stop", index });
  }
  events.push(
    {
      type: "message_delta",
      delta: {
        stop_reason: reply.stopReason,
        stop_sequence: null,
        ...verdict,
      },
      usage: { output_tokens: message.usage.output_tokens },
    },
    { type: "message_stop" },
  );
  return new Response(
    events
      .map(
        (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
        "request-id": requestId,
      },
    },
  );
}
