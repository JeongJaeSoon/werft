import {
  CONVERSATION_READ_TOOL_VALUES,
  CONVERSATION_TOOL_SERVER,
  type ConversationReadTool,
  type ConversationRuntimeTurn,
} from "@werft-ai/contracts";
import type { LocalToolServer } from "@werft-ai/runtime-core";
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
    "Lists this conversation's tasks that have not ended: their name, status and start.",
};

type HeldTurn = Pick<ConversationRuntimeTurn, "turn_id" | "lease_id">;

/**
 * The read tools of a topic session's engine. A session's tools carry its
 * key and nothing else; while a turn of its topic runs, a call goes to the
 * control host for that turn, which reads within the turn's scope. A call
 * while no turn holds the session is refused here.
 */
export class ConversationTools {
  private readonly held = new Map<string, HeldTurn>();

  constructor(
    private readonly source: Pick<ConversationTurnSource, "readTool">,
  ) {}

  hold(key: string, turn: HeldTurn): void {
    this.held.set(key, { turn_id: turn.turn_id, lease_id: turn.lease_id });
  }

  release(key: string): void {
    this.held.delete(key);
  }

  /** The tool server a session started on `key` gives its engine. */
  server(key: string): LocalToolServer {
    return {
      name: CONVERSATION_TOOL_SERVER,
      binding: `${CONVERSATION_TOOL_SERVER}-read-tools-1`,
      tools: CONVERSATION_READ_TOOL_VALUES.map((tool) => ({
        name: tool,
        description: READ_TOOL_DESCRIPTIONS[tool],
        call: (signal) => this.call(key, tool, signal),
      })),
    };
  }

  private async call(
    key: string,
    tool: ConversationReadTool,
    signal: AbortSignal,
  ): Promise<{ text: string; isError: boolean }> {
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
}
