import type { ConversationTopicId, ThreadReplyRule } from "@werft-ai/contracts";
import type { ChannelConversationKey } from "../../ports/conversation-store.ts";

/**
 * Where a person's unmentioned reply in a thread bound to work goes, once
 * the agent's rollout is `on` (v1-b/U1): `waiting` for M1's judgment, held
 * with its text; `session`, the work's turn, as M1 spoke or could not judge
 * it in time (PM Q2); `quiet`, nowhere, as M1 kept quiet.
 */
export type TaskReplyRoute = "waiting" | "session" | "quiet";

/** A reply in a thread whose work is going on, as the receive path read it. */
export type TaskReply = ChannelConversationKey & {
  topicId: ConversationTopicId;
  ts: string;
  body: string;
  slackUserId: string;
  /** What the current path's rule says, kept beside M1's judgment. */
  rule: ThreadReplyRule;
  /** How long its judgment may wait from its hold before the work takes it. */
  waitMs: number;
};

/** The receive path's reads and holds of a bound thread's replies. */
export interface BoundReplyStore {
  /**
   * Whether the session's work is going on (`open`: queued, running or
   * waiting for input) or done (`closed`), as a reply's judgment grades it.
   */
  work(sessionId: string): Promise<"open" | "closed">;
  /**
   * Holds the reply for its `m1_to_task` judgment the first time it is
   * asked, under the gate a judgment is written under, and answers what
   * became of it each time after: once the judgment has waited `waitMs`
   * it is given up and the work takes the reply. Nothing held (the gate
   * closed, the channel stopped listening, a mark came first) is
   * `session` too. A reply M1 kept quiet loses its held text.
   */
  taskReply(reply: TaskReply): Promise<TaskReplyRoute>;
}
