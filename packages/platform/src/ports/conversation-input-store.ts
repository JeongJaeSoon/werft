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
}
