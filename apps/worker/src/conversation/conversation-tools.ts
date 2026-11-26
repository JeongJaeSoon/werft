import {
  CONVERSATION_READ_TOOL_VALUES,
  CONVERSATION_TOOL_SERVER,
  CONVERSATION_TURN_REASON_MAX,
  CONVERSATION_TURN_TEXT_MAX,
  type ConversationDecision,
  type ConversationReadTool,
  type ConversationRuntimeTurn,
  type ConversationTurnDecision,
  conversationDecisionSchema,
  TASK_INTERPRETATION_TEXT_MAX,
} from "@werft-ai/contracts";
import type { LocalTool, LocalToolServer } from "@werft-ai/runtime-core";
import type { ConversationTurnSource } from "./turn-source.ts";

/** What each read tool tells the model it is for. */
export const READ_TOOL_DESCRIPTIONS: Record<ConversationReadTool, string> = {
  read_thread:
    "Reads the Slack thread of this conversation's current topic, from its first message. Only this thread.",
  read_channel_summary:
    "Reads the summary of this conversation's channel, as the agents in it keep it.",
  read_turns:
    "Lists this conversation's recent ended turns: when, what was decided and why, and the answer given.",
  list_open_tasks:
    "Lists this conversation's tasks that have not ended: their id, name, status and start.",
};

const ENDS_TURN =
  "It is this turn's one decision: call one decision tool once, then end the turn.";
/** What each decision tool tells the model it is for. */
export const DECISION_TOOL_DESCRIPTIONS: Record<
  ConversationTurnDecision,
  string
> = {
  reply: `Answers the person in this conversation with \`body\`, and says why in \`reason\`. ${ENDS_TURN}`,
  route_to_task: `Hands this message to one of the conversation's open tasks, by the \`task_id\` list_open_tasks gives, and says why. ${ENDS_TURN}`,
  spawn_task: `Starts a new task for this conversation: its \`goal\`, what \`done_when\` it is finished, and, when it is not the agent's usual one, the \`repository\` it works in. The person's message goes with it as they wrote it. Write no answer: the server tells the thread whether the task started. Says why in \`reason\`. ${ENDS_TURN}`,
  no_reply: `Stays quiet: nothing is said, and \`reason\` says why. ${ENDS_TURN}`,
};

const text = (maxLength: number) => ({
  type: "string",
  minLength: 1,
  maxLength,
});
const takes = (
  fields: Record<string, unknown>,
  optional: Record<string, unknown> = {},
) => ({
  type: "object",
  properties: {
    ...fields,
    ...optional,
    reason: text(CONVERSATION_TURN_REASON_MAX),
  },
  required: [...Object.keys(fields), "reason"],
  additionalProperties: false,
});
/**
 * What each decision tool takes, as the engine is told: its decision in
 * conversationDecisionSchema, but the tool's name. That schema judges it.
 */
export const DECISION_INPUT_SCHEMAS: Record<
  ConversationTurnDecision,
  Record<string, unknown>
> = {
  reply: takes({ body: text(CONVERSATION_TURN_TEXT_MAX) }),
  route_to_task: takes({ task_id: { type: "string", format: "uuid" } }),
  spawn_task: takes(
    {
      goal: text(TASK_INTERPRETATION_TEXT_MAX),
      done_when: text(TASK_INTERPRETATION_TEXT_MAX),
    },
    { repository: text(128) },
  ),
  no_reply: takes({}),
};

type HeldTurn = Pick<ConversationRuntimeTurn, "turn_id" | "lease_id">;
type Answer = { text: string; isError: boolean };

/**
 * The tools of a topic session's engine: the read tools, and the decision
 * tools the session was started with. A session's tools carry its key and
 * nothing else; while a turn of its topic runs, a call goes to the control
 * host for that turn. A call while no turn holds the session is refused
 * here. The first decision the control host accepts is the turn's; it is
 * reported with the turn's result, and another is refused.
 */
export class ConversationTools {
  private readonly held = new Map<string, HeldTurn>();
  private readonly decided = new Map<string, ConversationDecision>();
  // A decision call on its way: one beside it in the same message is refused.
  private readonly deciding = new Set<string>();

  constructor(
    private readonly source: Pick<
      ConversationTurnSource,
      "readTool" | "decisionTool"
    >,
  ) {}

  hold(key: string, turn: HeldTurn): void {
    this.held.set(key, { turn_id: turn.turn_id, lease_id: turn.lease_id });
    this.decided.delete(key);
  }

  release(key: string): void {
    this.held.delete(key);
    this.decided.delete(key);
  }

  /** The decision the running turn on `key` made; undefined for none. */
  decision(key: string): ConversationDecision | undefined {
    return this.decided.get(key);
  }

  /** The tool server a session started on `key` gives its engine. */
  server(
    key: string,
    decisions: readonly ConversationTurnDecision[],
  ): LocalToolServer {
    const reads: LocalTool[] = CONVERSATION_READ_TOOL_VALUES.map((tool) => ({
      name: tool,
      description: READ_TOOL_DESCRIPTIONS[tool],
      call: (signal) => this.read(key, tool, signal),
    }));
    const decides: LocalTool[] = decisions.map((tool) => ({
      name: tool,
      description: DECISION_TOOL_DESCRIPTIONS[tool],
      inputSchema: DECISION_INPUT_SCHEMAS[tool],
      call: (signal, input) => this.decideFor(key, tool, input, signal),
    }));
    return {
      name: CONVERSATION_TOOL_SERVER,
      binding: `${CONVERSATION_TOOL_SERVER}-tools-2:${decisions.join(",")}`,
      tools: [...reads, ...decides],
    };
  }

  private async read(
    key: string,
    tool: ConversationReadTool,
    signal: AbortSignal,
  ): Promise<Answer> {
    const turn = this.held.get(key);
    if (turn === undefined) {
      return { text: "No turn is running in this session.", isError: true };
    }
    let answer: Awaited<ReturnType<ConversationTurnSource["readTool"]>>;
    try {
      answer = await this.source.readTool(turn, tool, signal);
    } catch {
      return {
        text: "The read did not arrive; go on without it.",
        isError: true,
      };
    }
    if (answer.outcome === "read") return { text: answer.text, isError: false };
    const reason =
      answer.outcome === "refused" ? answer.reason : "turn_not_held";
    return {
      text: `Refused (${reason}); go on with what else this turn has.`,
      isError: true,
    };
  }

  private async decideFor(
    key: string,
    tool: ConversationTurnDecision,
    input: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Answer> {
    const turn = this.held.get(key);
    if (turn === undefined) {
      return { text: "No turn is running in this session.", isError: true };
    }
    if (this.decided.has(key) || this.deciding.has(key)) {
      return {
        text: "This turn has its decision already: end the turn now.",
        isError: true,
      };
    }
    const parsed = conversationDecisionSchema.safeParse({ ...input, tool });
    if (!parsed.success) {
      // The fields at fault, never what was in them.
      const fields = [
        ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
      ].join(", ");
      return {
        text: `Not a valid ${tool} call (${fields || "input"}); call it again with what it takes.`,
        isError: true,
      };
    }
    let answer: Awaited<ReturnType<ConversationTurnSource["decisionTool"]>>;
    this.deciding.add(key);
    try {
      answer = await this.source.decisionTool(turn, parsed.data, signal);
    } catch {
      return {
        text: "The decision did not arrive; call it again.",
        isError: true,
      };
    } finally {
      this.deciding.delete(key);
    }
    if (answer.outcome === "accepted") {
      // Held only while the turn still is.
      if (this.held.get(key)?.turn_id === turn.turn_id) {
        this.decided.set(key, parsed.data);
      }
      return {
        text: "Taken as this turn's decision. End the turn now, with no more tool calls.",
        isError: false,
      };
    }
    const reason =
      answer.outcome === "refused" ? answer.reason : "turn_not_held";
    return {
      text: `Refused (${reason}); this is not the turn's decision.`,
      isError: true,
    };
  }
}
