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
  profileId: string;
  sessionId: string | null;
  createdBy: string | null;
  revokedAt: Date | null;
};

export type SessionLinkReservation = Omit<
  SessionLinkRecord,
  "id" | "sessionId" | "revokedAt"
>;

export interface SessionLinkStore {
  /** The thread's link, live or revoked; null when it has none. */
  find(
    installationId: string,
    surfaceRef: string,
  ): Promise<SessionLinkRecord | null>;
  /**
   * Takes the thread's link in one transaction: the row this call inserts,
   * or, when another event already holds the key, that row read under lock.
   * `reserved` says which.
   */
  reserve(
    input: SessionLinkReservation,
  ): Promise<{ link: SessionLinkRecord; reserved: boolean }>;
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
   * Hands the opening to another message while the link names no session;
   * the answer is the row as it stands.
   */
  reopen(linkId: string, openedByTs: string): Promise<SessionLinkRecord>;
}
