import type {
  ConversationDecision,
  ConversationReadTool,
} from "@werft-ai/contracts";
import { ConversationTools } from "../conversation/conversation-tools.ts";
import type { ConversationTurnSource } from "../conversation/turn-source.ts";

type ReadAnswer = Awaited<ReturnType<ConversationTurnSource["readTool"]>>;
type DecisionAnswer = Awaited<
  ReturnType<ConversationTurnSource["decisionTool"]>
>;

export type FakeConversationTools = ConversationTools & {
  /** What every call answers; a test may swap it. */
  answer: (tool: ConversationReadTool) => ReadAnswer;
  /** What every decision call answers; accepted unless a test swaps it. */
  decide: (decision: ConversationDecision) => DecisionAnswer;
  calls: { turnId: string; leaseId: string; tool: ConversationReadTool }[];
  decisions: {
    turnId: string;
    leaseId: string;
    decision: ConversationDecision;
  }[];
};

/** The runtime's tools over a source that answers with `answer` and `decide`, keeping each call. */
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
      async decisionTool(turn, decision): Promise<DecisionAnswer> {
        tools.decisions.push({
          turnId: turn.turn_id,
          leaseId: turn.lease_id,
          decision,
        });
        return tools.decide(decision);
      },
    }),
    {
      answer: (tool: ConversationReadTool): ReadAnswer => ({
        outcome: "read",
        text: JSON.stringify({ read: tool }),
      }),
      decide: (): DecisionAnswer => ({ outcome: "accepted" }),
      calls: [],
      decisions: [],
    },
  );
  return tools;
}
