import type {
  ClientMessageId,
  ConversationId,
  ConversationInputId,
  ConversationInputSlackMirror,
  ConversationTopicId,
} from "@werft-ai/contracts";

/** A web input as the server took it. */
export type WebInputReceipt = {
  inputId: ConversationInputId;
  topicId: ConversationTopicId;
  /** From 1 within the topic, in the order the server took its inputs. */
  seq: number;
  requester: { kind: "user"; id: string };
  slackMirror: ConversationInputSlackMirror;
};

export type TakeWebInputRequest = {
  workspaceId: string;
  agentId: string;
  /** The signed-in person, a Werft user id. */
  requesterUserId: string;
  conversationId: ConversationId;
  /** Null opens a topic with no Slack alias. */
  topicId: ConversationTopicId | null;
  clientMessageId: ClientMessageId;
  body: string;
};

export type TakeWebInputResult =
  | { outcome: "taken"; receipt: WebInputReceipt }
  // The key was taken before with the same text: that receipt again.
  | { outcome: "replayed"; receipt: WebInputReceipt }
  | { outcome: "body_mismatch" }
  | { outcome: "not_member" }
  // A channel input from a person with no live Slack link in its team.
  | { outcome: "unlinked" }
  // No topic of that id in the conversation.
  | { outcome: "topic_not_found" };

export interface ConversationInputStore {
  /** Whether the user and their membership of the workspace are enabled. */
  isMember(workspaceId: string, userId: string): Promise<boolean>;
  /**
   * Takes a web input as the next of its topic, once per (agent, person,
   * client message id) however many retries race. A retry is answered
   * before anything else is judged again. A new input reads the person's
   * Slack links in the same transaction, which an unlink then waits for: a
   * channel input needs one in the channel's team, and a DM input with
   * none is `not_target`.
   */
  takeWebInput(request: TakeWebInputRequest): Promise<TakeWebInputResult>;
  /**
   * Sends an `unconfirmed` web input's Slack mirror again, as a person
   * asked: the input stays the one row it is, and a new mirror row with a
   * new correlation id goes, the input `pending` again. Only the input's
   * own person, in the conversation the grant was for; nothing else ever
   * calls it. `not_unconfirmed`: Slack has the post, or a mirror of it is
   * still on its way.
   */
  resendMirror(
    request: ResendMirrorRequest,
  ): Promise<"enqueued" | "not_found" | "not_unconfirmed">;
}

export type ResendMirrorRequest = {
  workspaceId: string;
  agentId: string;
  requesterUserId: string;
  conversationId: ConversationId;
  inputId: ConversationInputId;
};
