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
  specId: string | null;
  step: number | null;
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
      const step = items
        .slice(index + 1)
        .filter((later) => later.type === "function_call_output").length;
      return { spec, step };
    }
  }
  return null;
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
    specId: plan?.spec.id ?? null,
    step: plan?.step ?? null,
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
              name: next.tool,
              arguments: JSON.stringify(next.input),
            },
          ],
          ...(spec.usage ? { usage: spec.usage } : {}),
        };
  const delayMs = next === undefined ? spec.finalDelayMs : next.delayMs;
  return delayMs === undefined ? reply : Bun.sleep(delayMs).then(() => reply);
}
