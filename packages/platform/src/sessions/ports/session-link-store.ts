/**
 * A Slack thread's session. Reserved before the session exists;
 * `sessionId` is null until `createSession`, keyed by the link's id, has
 * answered once.
 */
export type SessionLinkRecord = {
  id: string;
  workspaceId: string;
  installationId: string;
  surfaceBindingId: string;
  /** `formatSurfaceRef(channelId, threadId)`. */
  surfaceRef: string;
  channelId: string;
  /** The thread's root ts: `thread_ts ?? ts` of the message that opened it. */
  threadId: string;
  /** The message whose turn opens the session. */
  openedByTs: string;
  agentId: string;
  releaseId: string;
  sessionId: string | null;
  createdBy: string | null;
  revokedAt: Date | null;
};

export type SessionLinkReservation = Omit<
  SessionLinkRecord,
  "id" | "sessionId" | "revokedAt"
>;

export interface SessionLinkStore {
  /**
   * The thread's open link, live or revoked; null when it has none. Closed
   * links are the thread's history and not found.
   */
  find(
    installationId: string,
    surfaceRef: string,
  ): Promise<SessionLinkRecord | null>;
  /**
   * Takes the thread's open link in one transaction: the row this call
   * inserts, or, when another event already holds the thread, that row read
   * under lock. A closed link does not hold it.
   * `reserved` says which.
   */
  reserve(
    input: SessionLinkReservation,
  ): Promise<{ link: SessionLinkRecord; reserved: boolean }>;
  /**
   * The sessions of the thread's closed links, the history `find` skips.
   */
  closedSessions(installationId: string, surfaceRef: string): Promise<string[]>;
  /**
   * Fills the link's session once. A link that already names a session
   * keeps it; the answer is the row as it stands.
   */
  attachSession(linkId: string, sessionId: string): Promise<SessionLinkRecord>;
  /**
   * The session `createSession` made under the link's id, when it answered
   * but the link was never filled; null when it never made one.
   */
  openedSession(link: SessionLinkRecord): Promise<string | null>;
  /**
   * The turn a Slack message became in `sessionId`, found by the message
   * the turn records; null when it made none there.
   */
  slackTurn(
    sessionId: string,
    message: { teamId: string; channelId: string; ts: string },
  ): Promise<{ sequence: number; requesterId: string | null } | null>;
  /**
   * Hands the opening to another message while the link names no session;
   * the answer is the row as it stands.
   */
  reopen(linkId: string, openedByTs: string): Promise<SessionLinkRecord>;
}
