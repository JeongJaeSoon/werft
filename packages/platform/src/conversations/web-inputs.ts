import {
  type AuthorizationAction,
  type AuthorizationDecision,
  type ConversationId,
  type ConversationTopicId,
  clientMessageIdSchema,
} from "@werft-ai/contracts";
import type {
  ConversationInputStore,
  WebInputReceipt,
} from "../ports/conversation-input-store.ts";
import type { ConversationStore } from "../ports/conversation-store.ts";

/**
 * The caller's `conversation.post` decision on this input. The service takes
 * nothing without an allowing one, so a caller cannot skip the check.
 */
export type ConversationPostGrant = {
  action: Extract<AuthorizationAction, "conversation.post">;
  /** The conversation the decision was on; a grant for another is none. */
  conversationId: ConversationId;
  decision: Pick<AuthorizationDecision, "outcome" | "reason_code">;
};

export type WebInputPlace =
  | { kind: "dm" }
  | { kind: "channel"; teamId: string; channelId: string };

export type ReceiveWebInput = {
  grant: ConversationPostGrant | null;
  workspaceId: string;
  agentId: string;
  /** The signed-in person; the server's record, never the client's word. */
  requesterUserId: string;
  place: WebInputPlace;
  /** Null opens a new topic. */
  topicId: ConversationTopicId | null;
  clientMessageId: string;
  body: string;
};

export type ReceiveWebInputResult =
  | { outcome: "taken" | "replayed"; receipt: WebInputReceipt }
  // The same key came with other text: a 409.
  | { outcome: "conflict" }
  | {
      outcome: "refused";
      reason:
        | "not_allowed"
        | "not_member"
        // A channel input needs a Slack account in the channel's team.
        | "unlinked"
        | "topic_not_found";
    }
  | { outcome: "invalid"; field: "client_message_id" | "body" };

export function createWebInputService(deps: {
  conversations: Pick<ConversationStore, "findOrCreateConversation">;
  inputs: ConversationInputStore;
}) {
  async function receive(
    input: ReceiveWebInput,
  ): Promise<ReceiveWebInputResult> {
    const clientMessageId = clientMessageIdSchema.safeParse(
      input.clientMessageId,
    );
    if (!clientMessageId.success) {
      return { outcome: "invalid", field: "client_message_id" };
    }
    if (input.body.length === 0) return { outcome: "invalid", field: "body" };
    if (
      input.grant?.action !== "conversation.post" ||
      input.grant.decision.outcome !== "allow"
    ) {
      return { outcome: "refused", reason: "not_allowed" };
    }
    // A DM conversation names its person, whom the table holds to a member.
    if (
      !(await deps.inputs.isMember(input.workspaceId, input.requesterUserId))
    ) {
      return { outcome: "refused", reason: "not_member" };
    }
    const place = input.place;
    const conversation = await deps.conversations.findOrCreateConversation(
      place.kind === "channel"
        ? {
            kind: "channel",
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            teamId: place.teamId,
            channelId: place.channelId,
          }
        : {
            kind: "dm",
            workspaceId: input.workspaceId,
            agentId: input.agentId,
            personUserId: input.requesterUserId,
          },
    );
    if (
      input.grant.conversationId.toLowerCase() !== conversation.id.toLowerCase()
    ) {
      return { outcome: "refused", reason: "not_allowed" };
    }
    const taken = await deps.inputs.takeWebInput({
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      requesterUserId: input.requesterUserId,
      conversationId: conversation.id,
      topicId: input.topicId,
      clientMessageId: clientMessageId.data,
      body: input.body,
    });
    switch (taken.outcome) {
      case "taken":
      case "replayed":
        return taken;
      case "body_mismatch":
        return { outcome: "conflict" };
      case "not_member":
      case "unlinked":
      case "topic_not_found":
        return { outcome: "refused", reason: taken.outcome };
    }
  }

  return { receive };
}

export type WebInputService = ReturnType<typeof createWebInputService>;
