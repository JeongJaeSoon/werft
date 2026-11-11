/**
 * Local stand-in for the OpenAI Responses API (`POST /v1/responses`). Speaks
 * the streaming (SSE) and non-streaming shapes, so the egress proxy's usage
 * meter and a Codex-style client can be pointed at it with no paid call.
 *
 * It records every request that reaches it, whatever the method or path, and
 * answers a path it does not serve with a 404. What a client contacts beside
 * `/v1/responses` (an update check, telemetry, a model list) therefore shows
 * up in `requests` instead of being lost.
 */

export type ResponsesRequest = {
  input?: unknown;
  model?: string;
  stream?: boolean;
  tools?: unknown[];
} & Record<string, unknown>;

export type FakeToolCall = {
  /** The id the model's caller answers with. */
  callId: string;
  name: string;
  /** Set for an MCP tool, which Codex offers and calls inside `mcp__<server>`. */
  namespace?: string;
  /**
   * `tool_search` is Codex's client-side search over the tools it defers, with
   * `arguments` the `{ query }` JSON; its answer comes back as a
   * `tool_search_output` item, not a `function_call_output`.
   */
  kind?: "tool_search";
  /** The arguments as a JSON string, as the API sends them. */
  arguments: string;
};

export type FakeResponse = {
  /** `incomplete` ends the response early, as when it hit `max_output_tokens`. */
  status?: "completed" | "incomplete";
  text?: string;
  toolCalls?: readonly FakeToolCall[];
  /**
   * Token counts to report, which is how a test makes a reply cost something.
   * `cached_tokens` is the part of `input_tokens` served from cache.
   */
  usage?: {
    input_tokens: number;
    output_tokens: number;
    cached_tokens?: number;
    reasoning_tokens?: number;
  };
};

export type RecordedRequest = {
  /** The parsed JSON body, the raw text when it is not JSON, null when empty. */
  body: ResponsesRequest | string | null;
  headers: Record<string, string>;
  method: string;
  /** Path and query, as the client sent them. */
  path: string;
  signal: AbortSignal;
};

export type FakeFailure = {
  code?: string;
  message?: string;
  status: number;
  type?: string;
};

export type ReplyResolver = (
  request: RecordedRequest & { body: ResponsesRequest },
  index: number,
) => FakeResponse | Response | Promise<FakeResponse | Response>;

/**
 * A single reply repeats for every request; an array is consumed in order and
 * its last entry repeats once exhausted; a function decides per request.
 */
export type ResponsesScript =
  | FakeResponse
  | Response
  | ReadonlyArray<FakeResponse | Response>
  | ReplyResolver;

export type FakeResponsesOptions = {
  /** Inject an OpenAI-style error instead of the scripted reply. */
  failWith?:
    | FakeFailure
    | ((request: RecordedRequest, index: number) => FakeFailure | undefined);
  /** Delay before every response, applied before `failWith` and the reply. */
  latencyMs?: number;
  /** Serve HTTPS with this certificate. */
  tls?: { cert: string; key: string };
  /** Where to listen; loopback on a free port unless a long-running host says otherwise. */
  listen?: { hostname: string; port: number };
};

export type FakeResponsesServer = {
  /** Every request, in arrival order, served or not. */
  requests: RecordedRequest[];
  stop(): void;
  url: string;
};

const defaultModel = "gpt-5.5";
const SERVED_PATH = "/v1/responses";

export function startFakeResponsesServer(
  replies: ResponsesScript,
  options: FakeResponsesOptions = {},
): FakeResponsesServer {
  const requests: RecordedRequest[] = [];
  const resolve = toResolver(replies);
  const server = Bun.serve({
    hostname: options.listen?.hostname ?? "127.0.0.1",
    port: options.listen?.port ?? 0,
    ...(options.tls === undefined ? {} : { tls: options.tls }),
    async fetch(request) {
      const url = new URL(request.url);
      const recorded: RecordedRequest = {
        body: await bodyOf(request),
        headers: Object.fromEntries(request.headers.entries()),
        method: request.method,
        path: `${url.pathname}${url.search}`,
        signal: request.signal,
      };
      requests.push(recorded);
      if (request.method !== "POST" || url.pathname !== SERVED_PATH) {
        return new Response("not found", { status: 404 });
      }
      const index = requests.filter(served).length - 1;
      if (options.latencyMs !== undefined && options.latencyMs > 0) {
        await Bun.sleep(options.latencyMs);
      }
      const failure =
        typeof options.failWith === "function"
          ? options.failWith(recorded, index)
          : options.failWith;
      if (failure !== undefined) return errorResponse(failure);
      const body = isRequest(recorded.body) ? recorded.body : {};
      const reply = await resolve({ ...recorded, body }, index);
      if (reply instanceof Response) return reusable(reply);
      return responsesResponse(body.model ?? defaultModel, reply, body.stream);
    },
  });
  return {
    requests,
    stop: () => server.stop(true),
    url: `${options.tls === undefined ? "http" : "https"}://${options.listen?.hostname ?? "127.0.0.1"}:${server.port}`,
  };
}

/** Whether a recorded request was one this server answers with a script. */
function served(request: RecordedRequest): boolean {
  return (
    request.method === "POST" && request.path.split("?")[0] === SERVED_PATH
  );
}

function isRequest(body: RecordedRequest["body"]): body is ResponsesRequest {
  return typeof body === "object" && body !== null;
}

async function bodyOf(request: Request): Promise<RecordedRequest["body"]> {
  const text = await request.text();
  if (text === "") return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as ResponsesRequest)
      : text;
  } catch {
    return text;
  }
}

export function textResponse(text: string): FakeResponse {
  return { text };
}

export function toolCallResponse(
  name: string,
  args: Record<string, unknown>,
  callId = `call_${crypto.randomUUID()}`,
): FakeResponse {
  return { toolCalls: [{ callId, name, arguments: JSON.stringify(args) }] };
}

export function serverError(status = 500, message = "Internal server error") {
  return {
    code: "server_error",
    message,
    status,
    type: "server_error",
  } satisfies FakeFailure;
}

export function quotaError(message = "Rate limit exceeded") {
  return {
    code: "rate_limit_exceeded",
    message,
    status: 429,
    type: "rate_limit_error",
  } satisfies FakeFailure;
}

export function errorResponse(failure: FakeFailure): Response {
  return Response.json(
    {
      error: {
        code: failure.code ?? null,
        message: failure.message ?? `HTTP ${failure.status}`,
        param: null,
        type: failure.type ?? "api_error",
      },
    },
    {
      status: failure.status,
      headers: { "x-request-id": `req_${crypto.randomUUID()}` },
    },
  );
}

// A scripted Response may be served more than once, so hand out a copy and
// keep the original body unread.
function reusable(response: Response): Response {
  const copy = response.clone();
  return new Response(copy.body, {
    headers: copy.headers,
    status: copy.status,
    statusText: copy.statusText,
  });
}

function toResolver(replies: ResponsesScript): ReplyResolver {
  if (typeof replies === "function") return replies;
  if (Array.isArray(replies)) {
    const script = replies as ReadonlyArray<FakeResponse | Response>;
    if (script.length === 0) {
      throw new Error("Fake Responses reply script must not be empty");
    }
    return (_request, index) =>
      script[Math.min(index, script.length - 1)] as FakeResponse | Response;
  }
  return () => replies as FakeResponse | Response;
}

type OutputItem = Record<string, unknown>;

function outputOf(reply: FakeResponse): OutputItem[] {
  const items: OutputItem[] = [];
  if (reply.text !== undefined) {
    items.push({
      type: "message",
      id: `msg_${crypto.randomUUID()}`,
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: reply.text, annotations: [] }],
    });
  }
  for (const call of reply.toolCalls ?? []) {
    if (call.kind === "tool_search") {
      items.push({
        type: "tool_search_call",
        id: `ts_${crypto.randomUUID()}`,
        call_id: call.callId,
        execution: "client",
        arguments: JSON.parse(call.arguments),
        status: "completed",
      });
      continue;
    }
    items.push({
      type: "function_call",
      id: `fc_${crypto.randomUUID()}`,
      call_id: call.callId,
      ...(call.namespace === undefined ? {} : { namespace: call.namespace }),
      name: call.name,
      arguments: call.arguments,
      status: "completed",
    });
  }
  return items;
}

function usageOf(reply: FakeResponse) {
  const counts = reply.usage ?? { input_tokens: 1, output_tokens: 4 };
  return {
    input_tokens: counts.input_tokens,
    input_tokens_details: { cached_tokens: counts.cached_tokens ?? 0 },
    output_tokens: counts.output_tokens,
    output_tokens_details: { reasoning_tokens: counts.reasoning_tokens ?? 0 },
    total_tokens: counts.input_tokens + counts.output_tokens,
  };
}

function responsesResponse(
  model: string,
  reply: FakeResponse,
  stream: unknown,
): Response {
  const id = `resp_${crypto.randomUUID()}`;
  const status = reply.status ?? "completed";
  const output = outputOf(reply);
  const response = {
    id,
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage: usageOf(reply),
    ...(status === "incomplete"
      ? { incomplete_details: { reason: "max_output_tokens" } }
      : {}),
  };
  const requestId = `req_${crypto.randomUUID()}`;
  if (stream !== true) {
    return Response.json(response, { headers: { "x-request-id": requestId } });
  }

  const started = {
    ...response,
    status: "in_progress",
    output: [],
    usage: null,
  };
  const events: Array<Record<string, unknown>> = [
    { type: "response.created", response: started },
    { type: "response.in_progress", response: started },
  ];
  for (const [index, item] of output.entries()) {
    events.push({
      type: "response.output_item.added",
      output_index: index,
      item: { ...item, status: "in_progress" },
    });
    if (item.type === "message") {
      const text = (item.content as Array<{ text: string }>)[0]?.text ?? "";
      events.push(
        {
          type: "response.output_text.delta",
          item_id: item.id,
          output_index: index,
          content_index: 0,
          delta: text,
        },
        {
          type: "response.output_text.done",
          item_id: item.id,
          output_index: index,
          content_index: 0,
          text,
        },
      );
    } else if (item.type === "function_call") {
      events.push(
        {
          type: "response.function_call_arguments.delta",
          item_id: item.id,
          output_index: index,
          delta: item.arguments,
        },
        {
          type: "response.function_call_arguments.done",
          item_id: item.id,
          output_index: index,
          arguments: item.arguments,
        },
      );
    }
    events.push({
      type: "response.output_item.done",
      output_index: index,
      item,
    });
  }
  events.push({
    type: status === "completed" ? "response.completed" : "response.incomplete",
    response,
  });
  return new Response(
    events
      .map(
        (event, sequence) =>
          `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number: sequence })}\n\n`,
      )
      .join(""),
    {
      headers: {
        "cache-control": "no-cache",
        "content-type": "text/event-stream",
        "x-request-id": requestId,
      },
    },
  );
}
