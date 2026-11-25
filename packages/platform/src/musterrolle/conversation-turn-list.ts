import {
  INITIATOR_ROOT_KINDS,
  type ListConversationTurnsQuery,
  type ListConversationTurnsResponse,
} from "@werft-ai/contracts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";

/** An agent's conversation turns, for its admins; no text. */
export interface ConversationTurnListStore {
  /**
   * Newest first by start, then id; with `rootKinds`, only turns charged to
   * one. A cursor the store did not mint throws InvalidCursorError.
   */
  page(input: {
    workspaceId: string;
    agentId: string;
    rootKinds: readonly string[] | null;
    cursor: string | undefined;
    limit: number;
  }): Promise<{
    items: ListConversationTurnsResponse["items"];
    nextCursor: string | null;
  }>;
}

/**
 * Who reads an agent's conversation turns (v1-b/V2): owners, admins and the
 * agent's admins, every place's alike, a DM's and a private channel's too
 * (the owner's call): what is shown is metadata, never anyone's text.
 */
export function createConversationTurnListService(deps: {
  authorization: AuthorizationPolicy;
  store: ConversationTurnListStore;
}) {
  const { authorization, store } = deps;
  return {
    async listConversationTurns(
      caller: Caller,
      agentId: string,
      query: ListConversationTurnsQuery,
    ): Promise<ListConversationTurnsResponse> {
      await requirePermitted(authorization, caller, "conversation_turn.read", {
        kind: "agent",
        id: agentId,
      });
      const page = await store.page({
        workspaceId: caller.ownerId,
        agentId,
        rootKinds:
          query.initiator === undefined
            ? null
            : INITIATOR_ROOT_KINDS[query.initiator],
        cursor: query.cursor,
        limit: query.limit,
      });
      return { items: page.items, next_cursor: page.nextCursor };
    },
  };
}

export type ConversationTurnListService = ReturnType<
  typeof createConversationTurnListService
>;
