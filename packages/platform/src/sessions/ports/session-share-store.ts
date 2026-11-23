import type {
  AdmissionState,
  SessionShareScope,
  SessionStatus,
} from "@werft-ai/contracts";
import type { Principal } from "../../musterrolle/index.ts";

/**
 * Who is looking at a session. A key no person stands behind (a service
 * key) is no member: it sees the ones it made and the workspace-wide
 * sessions of agents with no managing team (or every one, under axis B
 * `workspace`), and an agent key also its own agent's.
 */
export type SessionViewer = {
  userId: string | null;
  apiKeyId: string | null;
  /** The agent an agent key reaches; inside that agent (agent-rbac (b)). */
  keyAgentId?: string | null;
  /**
   * The conversations of the private channels whose sessions the viewer
   * may pass the door of: a person of the agent who is a member of the
   * channel now, as the policy judged it for this request. Absent or empty,
   * every such session is hidden; a key never has any.
   */
  privateChannels?: readonly string[];
};

/** The private channel a session behind its door came from (decision 26). */
export type PrivateChannelPlace = {
  conversationId: string;
  agentId: string;
  channelId: string;
  /** No binding names the channel's kind: held private all the same. */
  kindUnknown?: true;
};

/** Who made a session. A null user is a key's session (D21). */
export type SessionOrigin = {
  creatorUserId: string | null;
  creatorApiKeyId: string | null;
};

/** `revision` is 0 for a session never re-shared, which reads `workspace`. */
export type SessionShare = {
  sessionId: string;
  scope: SessionShareScope;
  userIds: string[];
  teamIds: string[];
  revision: number;
  updatedBy: string | null;
  updatedAt: Date | null;
  /**
   * `workspace` would reach only those inside the session's agent, whatever
   * the scope is now: axis B is `managing_team` and the agent is not held by
   * the "Unassigned agents" team of migration 0243 (`holds_unassigned`).
   */
  audienceLimited: boolean;
};

export type SetSessionShareInput = {
  principal: Principal;
  ownerId: string;
  workspaceId: string;
  sessionId: string;
  scope: SessionShareScope;
  /** Only for `people`. */
  userIds: readonly string[];
  /** Only for `team`. */
  teamIds: readonly string[];
  expectedRevision?: number;
  updatedBy: string;
  receiptId: string;
};

/**
 * `invalid_target`: a named person is not a live member of the workspace, or
 * a named team does not exist there. `actor_inactive`: the person changing it
 * left since the decision.
 */
export type SetSessionShareResult =
  | { outcome: "changed" | "unchanged"; share: SessionShare }
  | { outcome: "not_found" | "invalid_target" | "actor_inactive" }
  /** A preview session, which no one widens past its creator. */
  | { outcome: "preview_fixed" }
  /** A private_channel session, whose channel alone says who sees it. */
  | { outcome: "channel_fixed" }
  | { outcome: "revision_conflict"; currentRevision: number };

/** A session as a manager lists it: metadata only, never content. */
export type AdminSessionRow = {
  sessionId: string;
  createdByUserId: string | null;
  createdByApiKeyId: string | null;
  agentReleaseId: string | null;
  status: SessionStatus;
  admissionState: AdmissionState;
  shareScope: SessionShareScope;
  createdAt: Date;
  takeoverRequiredAt: Date | null;
};

export interface SessionShareStore {
  /** Read now, never cached: a team's members are its members today. */
  visibleTo(
    ownerId: string,
    sessionId: string,
    viewer: SessionViewer,
  ): Promise<boolean>;
  originOf(ownerId: string, sessionId: string): Promise<SessionOrigin | null>;
  /**
   * The private channels of the sessions behind one's door (a
   * `private_channel` share, or a parent conversation that is a private
   * channel, whatever the share): that session's, or with a null id every
   * one of the owner's.
   */
  privateChannels(
    ownerId: string,
    sessionId: string | null,
  ): Promise<PrivateChannelPlace[]>;
  /**
   * The person a push request is whose: the requester of the turn that
   * asked for it (that turn's root when it was itself a push follow-up), or
   * the person who asked over the API; with no person there, whoever
   * started the session. Null when none is a person or the request is not
   * the session's.
   */
  pushRequesterOf(
    ownerId: string,
    sessionId: string,
    pushRequestId: string,
  ): Promise<string | null>;
  get(ownerId: string, sessionId: string): Promise<SessionShare | null>;
  /** Wakes the session's open streams so each re-checks what it may see. */
  set(input: SetSessionShareInput): Promise<SetSessionShareResult>;
  /** Newest first, whatever each session's share. */
  listForAdmin(ownerId: string, limit: number): Promise<AdminSessionRow[]>;
}
