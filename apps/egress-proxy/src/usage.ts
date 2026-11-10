/**
 * What one Messages call used, read off the answer on its way to the worker
 * . The engine's own figure is its SDK's `total_cost_usd`, which a
 * tool calling the route with the engine's token never shows up in; the
 * proxy sees every call, so it is where those are counted.
 *
 * A JSON answer carries `usage` whole. A streamed one opens with
 * `message_start`, whose message has the input side, and each
 * `message_delta` carries running totals — the output count at least, and
 * the input side again on newer API versions — so the last one wins field
 * by field.
 *
 * Whatever the answer did not say is estimated high, never left out: the
 * budget errs on counting too much. A stream cut before `message_stop`
 * charges at least a token for every character of content it delivered,
 * and a web search for every search result it delivered. A
 * JSON answer with no usable usage (cut short, too big, not JSON) is
 * charged from its request: a token for every byte sent, and all the
 * output `max_tokens` allowed.
 *
 * The speed is priced too: the answer's `usage.speed`, or the
 * request's `speed` when the answer does not say. So are the server tools
 * the answer counted in `usage.server_tool_use`, and where it ran
 * the answer's `usage.inference_geo`, else the request's `inference_geo`,
 * else `unknown`, since a workspace's default may be the dearer one.
 *
 * A Responses call (`/v1/responses`) is read into the same figures. Its JSON
 * answer carries `usage` whole, and a streamed one ends with
 * `response.completed` (or `response.incomplete`), whose `response` has the
 * model and the usage; a stream cut before one is charged like a cut Messages
 * stream. Its `input_tokens` count the cached ones too, so the cached share
 * (`input_tokens_details.cached_tokens`) moves to `cache_read_input_tokens`
 * and only the rest stays input. The request's `max_output_tokens` bounds
 * the estimate where `max_tokens` does for Messages. Its reasoning tokens are
 * already inside `output_tokens`.
 */

/** The figures of one metered call, whichever API the answer came from. */
export type MessagesUsage = {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  /** The part of the cache writes held for an hour, which costs more. */
  cache_creation_1h_input_tokens: number;
  /** `standard`, `fast`, or `unknown` for a value that is not a name. */
  speed: string;
  /** `global`, `us`, or `unknown` when nothing said or not a name. */
  inference_geo: string;
  web_search_requests: number;
  web_fetch_requests: number;
  code_execution_requests: number;
  /** Some of it was estimated rather than read off the answer. */
  estimated: boolean;
};

const COUNTS = [
  "input_tokens",
  "output_tokens",
  "cache_creation_input_tokens",
  "cache_read_input_tokens",
] as const;

const TOOL_COUNTS = [
  "web_search_requests",
  "web_fetch_requests",
  "code_execution_requests",
] as const;

/**
 * A JSON answer read only up to this; one with 128K output tokens is well
 * inside it. Past it the call is charged from its request instead.
 */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
/** An SSE line longer than this is a content delta, never a usage event. */
const MAX_EVENT_LINE_BYTES = 256 * 1024;
/** What a request that names no model is priced as: the fallback rate. */
const UNKNOWN_MODEL = "unknown";
/** Longer than any speed's or geo's name; what the API's report schema accepts. */
const MAX_NAME_LENGTH = 64;

type Counts = Partial<
  Record<(typeof COUNTS)[number] | (typeof TOOL_COUNTS)[number], number>
> & {
  oneHour?: number;
  speed?: string;
  inferenceGeo?: string;
};

/** Absent or null says nothing; anything but a name is priced high. */
function nameOf(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" &&
    value !== "" &&
    value.length <= MAX_NAME_LENGTH
    ? value
    : "unknown";
}

function requested(request: Uint8Array | null): {
  model: string;
  maxTokens: number;
  speed: string;
  inferenceGeo: string;
} {
  try {
    const body = JSON.parse(new TextDecoder().decode(request ?? undefined));
    return {
      model:
        typeof body?.model === "string" && body.model !== ""
          ? body.model
          : UNKNOWN_MODEL,
      maxTokens: count(body?.max_tokens) ?? count(body?.max_output_tokens) ?? 0,
      speed: nameOf(body?.speed) ?? tierSpeed(body?.service_tier),
      inferenceGeo: nameOf(body?.inference_geo) ?? "unknown",
    };
  } catch {
    return {
      model: UNKNOWN_MODEL,
      maxTokens: 0,
      speed: "standard",
      inferenceGeo: "unknown",
    };
  }
}

/** A Responses `service_tier` of `priority` or `fast` is the fast speed. */
function tierSpeed(tier: unknown): string {
  return tier === "priority" || tier === "fast" ? "fast" : "standard";
}

/**
 * What a Responses object says beside its `usage`: the tier it ran at, and
 * the searches that ran (a failed one is not billed).
 */
function responseExtras(answer: unknown): Counts {
  if (typeof answer !== "object" || answer === null) return {};
  const { service_tier: tier, output } = answer as Record<string, unknown>;
  const extras: Counts = {};
  if (typeof tier === "string") extras.speed = tierSpeed(tier);
  if (Array.isArray(output)) {
    extras.web_search_requests = output.filter(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        (item as Record<string, unknown>).type === "web_search_call" &&
        (item as Record<string, unknown>).status !== "failed",
    ).length;
  }
  return extras;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function countsOf(value: unknown): Counts {
  if (typeof value !== "object" || value === null) return {};
  const counts: Counts = {};
  for (const name of COUNTS) {
    const found = count((value as Record<string, unknown>)[name]);
    if (found !== undefined) counts[name] = found;
  }
  // A Responses answer: its input already includes the cached tokens.
  const details = (value as Record<string, unknown>).input_tokens_details;
  const cached =
    typeof details === "object" && details !== null
      ? count((details as Record<string, unknown>).cached_tokens)
      : undefined;
  if (cached !== undefined) {
    counts.cache_read_input_tokens = cached;
  }
  // GPT-5.6 and later also report what the call wrote to the cache, by
  // lifetime; a write is billed above the plain input rate, so it comes out
  // of the input too. The 12-hour write rides the one-hour slot.
  const written =
    typeof details === "object" && details !== null
      ? count((details as Record<string, unknown>).cache_write_tokens)
      : undefined;
  if (written !== undefined) {
    counts.cache_creation_input_tokens = written;
    const lifetimes = (details as Record<string, unknown>)
      .cache_write_tokens_details;
    const twelveHours =
      typeof lifetimes === "object" && lifetimes !== null
        ? count((lifetimes as Record<string, unknown>).ttl_12h_tokens)
        : undefined;
    if (twelveHours !== undefined) counts.oneHour = twelveHours;
  }
  if (
    (cached !== undefined || written !== undefined) &&
    counts.input_tokens !== undefined
  ) {
    counts.input_tokens = Math.max(
      0,
      counts.input_tokens - (cached ?? 0) - (written ?? 0),
    );
  }
  const split = (value as Record<string, unknown>).cache_creation;
  if (typeof split === "object" && split !== null) {
    const oneHour = count(
      (split as Record<string, unknown>).ephemeral_1h_input_tokens,
    );
    if (oneHour !== undefined) counts.oneHour = oneHour;
  }
  const tools = (value as Record<string, unknown>).server_tool_use;
  if (typeof tools === "object" && tools !== null) {
    for (const name of TOOL_COUNTS) {
      const found = count((tools as Record<string, unknown>)[name]);
      if (found !== undefined) counts[name] = found;
    }
  }
  const speed = nameOf((value as Record<string, unknown>).speed);
  if (speed !== undefined) counts.speed = speed;
  const inferenceGeo = nameOf((value as Record<string, unknown>).inference_geo);
  if (inferenceGeo !== undefined) counts.inferenceGeo = inferenceGeo;
  return counts;
}

function usageOf(
  model: string,
  counts: Counts,
  estimated: boolean,
  request: Uint8Array | null,
): MessagesUsage {
  return {
    model,
    input_tokens: counts.input_tokens ?? 0,
    output_tokens: counts.output_tokens ?? 0,
    cache_creation_input_tokens: counts.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: counts.cache_read_input_tokens ?? 0,
    cache_creation_1h_input_tokens: Math.min(
      counts.oneHour ?? 0,
      counts.cache_creation_input_tokens ?? 0,
    ),
    speed: counts.speed ?? requested(request).speed,
    inference_geo: counts.inferenceGeo ?? requested(request).inferenceGeo,
    web_search_requests: counts.web_search_requests ?? 0,
    web_fetch_requests: counts.web_fetch_requests ?? 0,
    code_execution_requests: counts.code_execution_requests ?? 0,
    estimated,
  };
}

/** A call charged from its request alone: see the module comment. */
export function requestEstimate(request: Uint8Array | null): MessagesUsage {
  const { model, maxTokens, speed, inferenceGeo } = requested(request);
  return usageOf(
    model,
    {
      input_tokens: request?.byteLength ?? 0,
      output_tokens: maxTokens,
      speed,
      inferenceGeo,
    },
    true,
    request,
  );
}

export type UsageMeter = {
  observe(chunk: Uint8Array): void;
  /** What the answer said it used, estimated where it said too little. */
  result(request: Uint8Array | null): MessagesUsage;
};

/**
 * `requestModel` is for the Decisions API, whose answer carries `usage` but
 * no `model`: the request's model is the one charged, whatever the answer
 * says, so a dated name never falls to the fallback rate.
 */
export function usageMeter(
  contentType: string | null,
  options: { requestModel?: boolean } = {},
): UsageMeter {
  const decoder = new TextDecoder();
  if ((contentType ?? "").toLowerCase().startsWith("text/event-stream")) {
    let model: string | undefined;
    let counts: Counts = {};
    let stopped = false;
    let delivered = 0;
    let searched = 0;
    // A Responses stream states its usage only in the last event, so one cut
    // short has no count to start from.
    let responses = false;
    let line = "";
    let skipping = false;
    const event = (data: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (typeof parsed !== "object" || parsed === null) return;
      const { type, message, usage, delta, response } = parsed as Record<
        string,
        unknown
      >;
      if (typeof type === "string" && type.startsWith("response.")) {
        const answer =
          typeof response === "object" && response !== null
            ? (response as Record<string, unknown>)
            : undefined;
        if (typeof answer?.model === "string") model = answer.model;
        responses = true;
        if (
          type === "response.completed" ||
          type === "response.incomplete" ||
          type === "response.failed"
        ) {
          counts = {
            ...counts,
            ...countsOf(answer?.usage),
            ...responseExtras(answer),
          };
          // A failed response, or one that names no usage, is not a full
          // account: it is charged like a stream that was cut.
          stopped =
            type !== "response.failed" &&
            typeof answer?.usage === "object" &&
            answer.usage !== null;
        } else if (type.endsWith(".delta") && typeof delta === "string") {
          delivered += delta.length;
        }
      } else if (type === "message_start" && typeof message === "object") {
        const started = message as Record<string, unknown> | null;
        if (typeof started?.model === "string") model = started.model;
        counts = { ...counts, ...countsOf(started?.usage) };
      } else if (type === "message_delta") {
        counts = { ...counts, ...countsOf(usage) };
      } else if (type === "message_stop") {
        stopped = true;
      } else if (type === "content_block_start") {
        // A failed search is not billed, and its content is an error object.
        const block = (parsed as Record<string, unknown>).content_block as
          | Record<string, unknown>
          | undefined;
        if (
          block?.type === "web_search_tool_result" &&
          Array.isArray(block.content)
        ) {
          searched += 1;
        }
      } else if (type === "content_block_delta") {
        const content = delta as Record<string, unknown> | null;
        for (const field of ["text", "partial_json", "thinking"]) {
          const part = content?.[field];
          if (typeof part === "string") delivered += part.length;
        }
      }
    };
    // A line too long to parse is counted from its head: a search result can
    // outgrow the limit, and only a successful one does, an error being a
    // few bytes. Its type fields lead the event.
    const skipped = (head: string) => {
      const start = head.slice(0, 512);
      if (
        start.startsWith("data:") &&
        start.includes('"content_block_start"') &&
        start.includes('"web_search_tool_result"')
      ) {
        searched += 1;
      }
    };
    return {
      observe(chunk) {
        const lines = decoder.decode(chunk, { stream: true }).split("\n");
        const last = lines.pop() ?? "";
        for (const piece of lines) {
          const whole = skipping ? piece : line + piece;
          if (skipping || whole.length > MAX_EVENT_LINE_BYTES) {
            if (!skipping) skipped(whole);
            delivered += whole.length;
          } else if (whole.startsWith("data:")) {
            event(whole.slice(5).trim());
          }
          line = "";
          skipping = false;
        }
        if (skipping) {
          delivered += last.length;
          return;
        }
        line += last;
        if (line.length > MAX_EVENT_LINE_BYTES) {
          skipped(line);
          delivered += line.length;
          line = "";
          skipping = true;
        }
      },
      result(request) {
        if (model === undefined) return requestEstimate(request);
        if (stopped) return usageOf(model, counts, false, request);
        // Hidden reasoning is billed as output yet never delivered, so a cut
        // Responses stream is charged what the request allowed.
        const allowed = responses ? requestEstimate(request) : undefined;
        return usageOf(
          model,
          {
            ...counts,
            ...(allowed === undefined
              ? {}
              : {
                  input_tokens: counts.input_tokens ?? allowed.input_tokens,
                  speed: counts.speed ?? allowed.speed,
                }),
            output_tokens: Math.max(
              counts.output_tokens ?? 0,
              delivered,
              allowed?.output_tokens ?? 0,
            ),
            web_search_requests: Math.max(
              counts.web_search_requests ?? 0,
              searched,
            ),
          },
          true,
          request,
        );
      },
    };
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  return {
    observe(chunk) {
      total += chunk.byteLength;
      if (total <= MAX_JSON_BYTES) chunks.push(chunk);
    },
    result(request) {
      if (total <= MAX_JSON_BYTES) {
        try {
          const body = JSON.parse(decoder.decode(Buffer.concat(chunks)));
          const model = options.requestModel
            ? requested(request).model
            : typeof body?.model === "string"
              ? body.model
              : undefined;
          if (
            model !== undefined &&
            typeof body.usage === "object" &&
            body.usage !== null
          ) {
            return usageOf(
              model,
              { ...countsOf(body.usage), ...responseExtras(body) },
              false,
              request,
            );
          }
        } catch {}
      }
      return requestEstimate(request);
    },
  };
}
