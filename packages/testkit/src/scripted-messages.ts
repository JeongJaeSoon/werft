import {
  type FakeReply,
  type RecordedRequest,
  textReply,
  toolReply,
} from "./fake-anthropic.ts";

/**
 * A Messages API whose script rides in the prompt, so a
 * long-running fake can serve any scenario without knowing it: a user text
 * block reading `GATE-SPEC {"id":…,"steps":[…],"final":…}` is the plan, and
 * the number of tool results after it says which step comes next. The Agent
 * tool's prompt carries its own spec, which is how a subagent gets one.
 *
 * Side requests the engine makes without tools (titles, summaries) are
 * answered with the fallback text and never read a spec, even when they
 * quote one.
 */

export const SPEC_MARKER = "GATE-SPEC ";

export type GateStep = {
  delayMs?: number;
  input: Record<string, unknown>;
  tool: string;
};

export type GateSpec = {
  final: string;
  finalDelayMs?: number;
  id: string;
  steps: GateStep[];
  /** Tokens each scripted reply reports; only the Responses fake reads it. */
  usage?: { input_tokens: number; output_tokens: number };
};

type Message = { content: unknown; role: string };
type Block = { text?: string; type: string };

export type GateRequest = {
  at: string;
  hasTools: boolean;
  index: number;
  messages: unknown[];
  specId: string | null;
  step: number | null;
  system: unknown;
  /** Names of the tools the request offered. */
  tools: string[];
};

function blocksOf(message: Message): Block[] {
  if (typeof message.content === "string") {
    return [{ type: "text", text: message.content }];
  }
  return Array.isArray(message.content) ? (message.content as Block[]) : [];
}

/** The latest spec in the conversation and how many tool results follow it. */
export function planOf(
  messages: readonly Message[],
): { spec: GateSpec; step: number } | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    // Last block first: after an interrupt the engine merges the cut-off
    // prompt and the next one into a single user message, and the newer
    // spec is the one being asked.
    const blocks = blocksOf(message);
    for (let at = blocks.length - 1; at >= 0; at--) {
      const block = blocks[at];
      if (block?.type !== "text" || block.text === undefined) continue;
      // The first marker: an Agent step's prompt carries the subagent's
      // spec inside this one, escaped as a JSON string.
      const marker = block.text.indexOf(SPEC_MARKER);
      if (marker < 0) continue;
      const spec = JSON.parse(
        firstJsonObject(block.text.slice(marker + SPEC_MARKER.length)),
      ) as GateSpec;
      let step = blocks
        .slice(at + 1)
        .filter((candidate) => candidate.type === "tool_result").length;
      for (const later of messages.slice(index + 1)) {
        if (later.role !== "user") continue;
        step += blocksOf(later).filter(
          (candidate) => candidate.type === "tool_result",
        ).length;
      }
      return { spec, step };
    }
  }
  return null;
}

/**
 * The id of every spec the conversation's user prompts carry, oldest first:
 * what the engine replayed to the model as history. A resumed session sends
 * its earlier prompts with the new one; a fresh one sends only the new one.
 */
export function specIdsIn(messages: readonly unknown[]): string[] {
  const ids: string[] = [];
  for (const message of messages as readonly Message[]) {
    if (message?.role !== "user") continue;
    for (const block of blocksOf(message)) {
      if (block.type !== "text" || block.text === undefined) continue;
      const marker = block.text.indexOf(SPEC_MARKER);
      if (marker < 0) continue;
      // A log reader, not a planner: a prompt that only mentions the marker
      // is skipped rather than failing the whole listing.
      try {
        const spec = JSON.parse(
          firstJsonObject(block.text.slice(marker + SPEC_MARKER.length)),
        ) as GateSpec;
        ids.push(spec.id);
      } catch {}
    }
  }
  return ids;
}

/** The spec is followed by whatever the engine appends to a prompt. */
export function firstJsonObject(text: string): string {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index++;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth++;
    else if (char === "}" && --depth === 0) return text.slice(0, index + 1);
  }
  throw new Error(`unterminated ${SPEC_MARKER.trim()}`);
}

export function replyFor(
  request: RecordedRequest,
  recorded: GateRequest[],
  fallback = "ok",
): Promise<FakeReply> | FakeReply {
  const messages = (request.body.messages ?? []) as Message[];
  const hasTools = (request.body.tools ?? []).length > 0;
  const plan = hasTools ? planOf(messages) : null;
  recorded.push({
    at: new Date().toISOString(),
    hasTools,
    index: recorded.length,
    messages,
    specId: plan?.spec.id ?? null,
    step: plan?.step ?? null,
    system: request.body.system,
    tools: (request.body.tools ?? []).flatMap((tool) => {
      const { name } = tool as { name?: unknown };
      return typeof name === "string" ? [name] : [];
    }),
  });
  if (plan === null) return textReply(fallback);
  const { spec, step } = plan;
  const next = spec.steps[step];
  const reply =
    next === undefined
      ? textReply(spec.final)
      : toolReply(next.tool, next.input, `toolu_gate_${spec.id}_${step}`);
  const delayMs = next === undefined ? spec.finalDelayMs : next.delayMs;
  return delayMs === undefined ? reply : Bun.sleep(delayMs).then(() => reply);
}
