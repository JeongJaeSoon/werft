import type { ConversationTopicId, ThreadReplyRule } from "@werft-ai/contracts";
import type { ChannelConversationKey } from "../../ports/conversation-store.ts";
import type { SurfaceInboundFence } from "./surface-inbound-event-store.ts";

/**
 * Where a person's unmentioned reply in a thread bound to work goes, once
 * the agent's rollout is `on` (v1-b/U1): `waiting` for M1's judgment, held
 * with its text; `session`, the work's turn, as M1 spoke or could not judge
 * it within the wait (PM Q2); `quiet`, nowhere, as M1 kept quiet within it.
 * `edited`: the work's turn on the held text, which an edit changed since
 * the post.
 */
export type TaskReplyRoute =
  | "waiting"
  | "session"
  | "quiet"
  | { edited: string };

/** A reply in a thread whose work is going on, as the receive path read it. */
export type TaskReply = ChannelConversationKey & {
  /** The inbox claim it came by: a claim lost writes nothing. */
  fence: SurfaceInboundFence;
  topicId: ConversationTopicId;
  ts: string;
  body: string;
  slackUserId: string;
  /** What the current path's rule says, kept beside M1's judgment. */
  rule: ThreadReplyRule;
  /** How long its judgment may wait from its hold before the work takes it. */
  waitMs: number;
};

/** A Slack post of an agent's channel. */
export type BoundReplyPost = {
  agentId: string;
  teamId: string;
  channelId: string;
  ts: string;
};

/** Work that is closed (decision 35), as a mention in its thread waits on it. */
export type ClosedWork =
  // receiptIdSchema parsed.
  | { admission: "closing"; closeReceiptId: string | null }
  | { admission: "closed" };

/** The receive path's reads and holds of a bound thread's replies. */
export interface BoundReplyStore {
  /**
   * Whether the session's work is going on (`open`) or done (`closed`:
   * closing or closed, decision 35), as a reply's judgment grades it.
   */
  work(sessionId: string): Promise<"open" | "closed">;
  /**
   * The session's work as a mention in its thread sees it (94S-2537): null
   * while it is open; `closing` with the close receipt its drain waits on
   * (null when none is found), or `closed`.
   */
  closedWork(sessionId: string): Promise<ClosedWork | null>;
  /**
   * Whether the post was held for its work's (`m1_to_task`) judgment: it
   * keeps that grade though the work closed while it waited.
   */
  heldForWork(post: BoundReplyPost): Promise<boolean>;
  /**
   * Holds the reply for its `m1_to_task` judgment the first time it is
   * asked, under the gate a judgment is written under, and answers what
   * became of it each time after: once the judgment has waited `waitMs`
   * it is given up and the work takes the reply. Nothing held (the gate
   * closed, the channel stopped listening, a mark came first, the buffer's
   * limit took it) is `session` too, and a post held once is not held
   * again. A reply M1 kept quiet loses its held text.
   */
  taskReply(reply: TaskReply): Promise<TaskReplyRoute>;
}
