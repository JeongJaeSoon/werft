import type { SessionTrigger } from "@werft-ai/contracts";

/**
 * Who a session's commits and pull requests are attributed to (design
 * github-agent.md decision 5), read now: a link made or dropped mid-session
 * shows from the next claim on.
 */
export type SessionAttributionRecord = {
  ownerId: string;
  trigger: SessionTrigger;
  agentId: string | null;
  agentReleaseId: string | null;
  /** Null when no person started it (an agent or operator key). */
  starter: {
    userId: string;
    /** Their active GitHub link, as GitHub named it at linking; else null. */
    github: { id: string; login: string } | null;
  } | null;
  /**
   * The console App the session's primary repository is pinned to for
   * `author`: its bot writes the commits (decision D11). Null without a pin,
   * or when the pinned connection is gone or holds another App now.
   */
  authorApp: { slug: string; apiBase: string } | null;
  /** Whether the primary repository has an author pin at all. */
  authorPinned: boolean;
};

/** Who asked for a turn: the person, if any, and the surface the input came from. */
export type TurnRequester = {
  userId: string | null;
  channel: "web" | "slack" | "api" | null;
};

export interface SessionAttributionStore {
  attribution(sessionId: string): Promise<SessionAttributionRecord | null>;
  /**
   * Who asked the session's latest turn, with their GitHub link: the
   * session detail's attribution line goes by it. Null when no turn exists.
   */
  lastRequesterOf(sessionId: string): Promise<{
    userId: string | null;
    github: { id: string; login: string } | null;
  } | null>;
  /** The person's active GitHub link in the session's workspace; else null. */
  githubLinkOf(
    sessionId: string,
    userId: string,
  ): Promise<{ id: string; login: string } | null>;
  /**
   * The requester of the turn whose push intent made this push request; null
   * when no intent did (a request a person made directly).
   */
  requesterOfPushRequest(
    sessionId: string,
    pushRequestId: string,
  ): Promise<TurnRequester | null>;
}
