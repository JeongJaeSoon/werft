import {
  type ListSessionGitHubRefusalsResponse,
  type ListSessionOutcomesResponse,
  SESSION_GITHUB_REFUSALS_LIMIT,
} from "@werft-ai/contracts";
import { requirePermitted, SessionServiceError } from "../musterrolle/index.ts";
import type { AuthorizationPolicy, Caller } from "../musterrolle/policy.ts";
import type { SessionOutcomeStore } from "./ports/session-outcomes.ts";

/** What the session made, and why GitHub work of it was refused; reads only. */
export function createSessionOutcomeService(deps: {
  authorization: AuthorizationPolicy;
  store: SessionOutcomeStore;
}) {
  const read = (caller: Caller, sessionId: string) =>
    requirePermitted(deps.authorization, caller, "session.read", {
      kind: "session",
      id: sessionId,
    });
  const found = <T>(items: T[] | null): { items: T[] } => {
    if (items === null) {
      throw new SessionServiceError("NOT_FOUND", "Resource not found");
    }
    return { items };
  };
  return {
    async list(
      caller: Caller,
      rawSessionId: string,
    ): Promise<ListSessionOutcomesResponse> {
      const sessionId = rawSessionId.toLowerCase();
      await read(caller, sessionId);
      return found(await deps.store.list(caller.ownerId, sessionId));
    },

    async refusals(
      caller: Caller,
      rawSessionId: string,
    ): Promise<ListSessionGitHubRefusalsResponse> {
      const sessionId = rawSessionId.toLowerCase();
      await read(caller, sessionId);
      return found(
        await deps.store.refusals(
          caller.ownerId,
          sessionId,
          SESSION_GITHUB_REFUSALS_LIMIT,
        ),
      );
    },
  };
}

export type SessionOutcomeService = ReturnType<
  typeof createSessionOutcomeService
>;
