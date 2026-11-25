import type { ConversationReadTool } from "@werft-ai/contracts";
import { ConversationTools } from "../conversation/conversation-tools.ts";
import type { ConversationTurnSource } from "../conversation/turn-source.ts";

type ReadAnswer = Awaited<ReturnType<ConversationTurnSource["readTool"]>>;

export type FakeConversationTools = ConversationTools & {
  /** What every call answers; a test may swap it. */
  answer: (tool: ConversationReadTool) => ReadAnswer;
  calls: { turnId: string; leaseId: string; tool: ConversationReadTool }[];
};

/** The runtime's read tools over a source that answers with `answer`, keeping each call. */
export function fakeConversationTools(): FakeConversationTools {
  const tools: FakeConversationTools = Object.assign(
    new ConversationTools({
      async readTool(turn, tool): Promise<ReadAnswer> {
        tools.calls.push({
          turnId: turn.turn_id,
          leaseId: turn.lease_id,
          tool,
        });
        return tools.answer(tool);
      },
    }),
    {
      answer: (tool: ConversationReadTool): ReadAnswer => ({
        outcome: "read",
        text: JSON.stringify({ read: tool }),
      }),
      calls: [],
    },
  );
  return tools;
}
