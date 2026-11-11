import type { FakeResponse, ResponsesRequest } from "./fake-responses.ts";
import {
  firstJsonObject,
  type GateSpec,
  SPEC_MARKER,
} from "./scripted-messages.ts";

/**
 * The Responses API twin of scripted-messages.ts: the script rides in the
 * prompt as the same `GATE-SPEC {…}` text, and the number of
 * `function_call_output` items after the latest prompt carrying one says
 * which step comes next. A request without tools (title or summary side
 * calls) never reads a spec.
 */

type Item = Record<string, unknown>;

export type ScriptedCall = {
  at: string;
  /** Ids of every spec the input replays, oldest first. */
  history: string[];
  /** `namespace/tool` names the input's `tool_search` answers returned. */
  found: string[];
  /** The text of each tool output the input carries, oldest first. */
  outputs: string[];
  specId: string | null;
  step: number | null;
  /** Tool names the request offered; a namespace's tools read `namespace/tool`. */
  tools: string[];
};

function textsOf(item: Item): string[] {
  if (item.type !== undefined && item.type !== "message") return [];
  if (item.role !== "user") return [];
  const { content } = item;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? [text] : [];
  });
}

function specIn(text: string): GateSpec | null {
  const marker = text.indexOf(SPEC_MARKER);
  if (marker < 0) return null;
  try {
    return JSON.parse(
      firstJsonObject(text.slice(marker + SPEC_MARKER.length)),
    ) as GateSpec;
  } catch {
    return null;
  }
}

export function inputItems(body: ResponsesRequest): Item[] {
  return Array.isArray(body.input) ? (body.input as Item[]) : [];
}

/** The latest spec in the input and how many tool outputs follow it. */
export function planOf(
  items: readonly Item[],
): { spec: GateSpec; step: number } | null {
  for (let index = items.length - 1; index >= 0; index--) {
    const item = items[index] as Item;
    for (const text of textsOf(item).reverse()) {
      const spec = specIn(text);
      if (spec === null) continue;
      const step = items.slice(index + 1).filter(isToolAnswer).length;
      return { spec, step };
    }
  }
  return null;
}

const isToolAnswer = (item: Item) =>
  item.type === "function_call_output" || item.type === "tool_search_output";

/** `name` for a function, `namespace/tool` for a tool inside a namespace. */
function namesIn(entries: readonly unknown[]): string[] {
  return entries.flatMap((entry) => {
    const { name, tools, type } = entry as {
      name?: unknown;
      tools?: unknown;
      type?: unknown;
    };
    if (typeof name !== "string") {
      return typeof type === "string" ? [type] : [];
    }
    if (!Array.isArray(tools)) return [name];
    return tools.flatMap((child) => {
      const childName = (child as { name?: unknown }).name;
      return typeof childName === "string" ? [`${name}/${childName}`] : [];
    });
  });
}

function toolNames(body: ResponsesRequest): string[] {
  return namesIn(body.tools ?? []);
}

const searchOffered = (body: ResponsesRequest) =>
  (body.tools ?? []).some((tool) => {
    const { type, execution } = tool as { type?: unknown; execution?: unknown };
    return type === "tool_search" && execution === "client";
  });

/** Names a `tool_search` answer returned, apart from any other tool output. */
function foundNames(items: readonly Item[]): string[] {
  return items.flatMap((item) =>
    item.type === "tool_search_output" && Array.isArray(item.tools)
      ? namesIn(item.tools)
      : [],
  );
}

/** The namespaces the model can call into: offered up front or found by `tool_search`. */
function namespacesOf(body: ResponsesRequest): Item[] {
  const found = inputItems(body).flatMap((item) =>
    item.type === "tool_search_output" && Array.isArray(item.tools)
      ? (item.tools as Item[])
      : [],
  );
  return [...((body.tools ?? []) as Item[]), ...found];
}

/**
 * `mcp__github__request_push` is the model's `request_push` in the
 * `mcp__github` namespace, but only a namespace the model was shown (offered
 * up front, or returned by `tool_search`) counts: a tool it was never shown
 * stays a plain name, which the engine answers as unsupported, so a script
 * cannot call what a real model could not.
 */
function mcpCall(
  tool: string,
  body: ResponsesRequest,
): { name: string; namespace?: string } {
  for (const entry of namespacesOf(body)) {
    const { name, tools } = entry as { name?: unknown; tools?: unknown };
    if (typeof name !== "string" || !Array.isArray(tools)) continue;
    const rest = tool.startsWith(`${name}__`)
      ? tool.slice(name.length + 2)
      : undefined;
    if (
      rest !== undefined &&
      tools.some((child) => (child as { name?: unknown }).name === rest)
    ) {
      return { namespace: name, name: rest };
    }
  }
  return { name: tool };
}

function outputTexts(items: readonly Item[]): string[] {
  return items.filter(isToolAnswer).map((item) => {
    // What the search found, as `namespace/tool` names.
    if (item.type === "tool_search_output") {
      return namesIn(Array.isArray(item.tools) ? item.tools : []).join(",");
    }
    const text =
      typeof item.output === "string"
        ? item.output
        : JSON.stringify(item.output ?? null);
    return text.slice(0, 400);
  });
}

export function specIdsIn(items: readonly Item[]): string[] {
  return items.flatMap((item) =>
    textsOf(item).flatMap((text) => {
      const spec = specIn(text);
      return spec === null ? [] : [spec.id];
    }),
  );
}

/** The reply for one request, recording it in `recorded`. */
export function replyFor(
  body: ResponsesRequest,
  recorded: ScriptedCall[],
  fallback = "ok",
): Promise<FakeResponse> | FakeResponse {
  const items = inputItems(body);
  const plan = (body.tools ?? []).length > 0 ? planOf(items) : null;
  recorded.push({
    at: new Date().toISOString(),
    history: specIdsIn(items),
    found: foundNames(items),
    outputs: outputTexts(items),
    specId: plan?.spec.id ?? null,
    step: plan?.step ?? null,
    tools: toolNames(body),
  });
  if (plan === null) return { text: fallback };
  const { spec, step } = plan;
  const next = spec.steps[step];
  const reply: FakeResponse =
    next === undefined
      ? { text: spec.final, ...(spec.usage ? { usage: spec.usage } : {}) }
      : {
          toolCalls: [
            {
              callId: `call_gate_${spec.id}_${step}`,
              // Only a request that offers the search can be answered by one;
              // otherwise the call is a plain name the engine refuses.
              ...(next.tool === "tool_search" && searchOffered(body)
                ? { kind: "tool_search" as const, name: next.tool }
                : mcpCall(next.tool, body)),
              arguments: JSON.stringify(next.input),
            },
          ],
          ...(spec.usage ? { usage: spec.usage } : {}),
        };
  const delayMs = next === undefined ? spec.finalDelayMs : next.delayMs;
  return delayMs === undefined ? reply : Bun.sleep(delayMs).then(() => reply);
}
