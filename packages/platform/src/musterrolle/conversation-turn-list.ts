import {
  INITIATOR_ROOT_KINDS,
  type ListConversationTurnsQuery,
  type ListConversationTurnsResponse,
} from "@werft-ai/contracts";
import type { AgentStore } from "../agents/ports/agent-store.ts";
import type { AuthorizationPolicy, Caller } from "./policy.ts";
import { requirePermitted } from "./require-permitted.ts";
import { NOT_FOUND } from "./service-errors.ts";

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
  agents: Pick<AgentStore, "get">;
  store: ConversationTurnListStore;
}) {
  const { authorization, agents, store } = deps;
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
      // A manager is allowed whatever the id names; a deleted agent's turns
      // are not listed either.
      if ((await agents.get(caller.ownerId, agentId)) === null) {
        throw NOT_FOUND();
      }
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
