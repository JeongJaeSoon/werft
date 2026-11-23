import { type ScopeKey, scopeKeyOf } from "@werft-ai/contracts";
import type {
  ContextFragment,
  ContextFragmentSource,
} from "../ports/context-fragment-source.ts";
import type { ConversationKey } from "../ports/conversation-store.ts";

/**
 * The scopes a conversation may read (9-2): a channel conversation its
 * channel's, a DM its person's, and either its agent's. Another channel,
 * another person's DM and a person scope in a channel are never in it.
 */
export function readableScopes(conversation: ConversationKey): ScopeKey[] {
  const own =
    conversation.kind === "channel"
      ? scopeKeyOf({
          kind: "channel",
          workspaceId: conversation.workspaceId,
          teamId: conversation.teamId,
          channelId: conversation.channelId,
        })
      : scopeKeyOf({
          kind: "person",
          workspaceId: conversation.workspaceId,
          userId: conversation.personUserId,
        });
  return [
    own,
    scopeKeyOf({
      kind: "agent",
      workspaceId: conversation.workspaceId,
      agentId: conversation.agentId,
    }),
  ];
}

/**
 * The context assembler (G1): the fragments a conversation may read, each
 * with its scope and sources. A fragment whose scope is not one the
 * conversation reads is dropped here even if the source returned it.
 * Calls no model; order and the size cut are a1's.
 */
export async function assembleContext(
  source: ContextFragmentSource,
  conversation: ConversationKey,
): Promise<ContextFragment[]> {
  const readable = new Set<string>(readableScopes(conversation));
  return (await source.fragmentsOf(conversation)).filter((fragment) =>
    readable.has(fragment.scope),
  );
}
