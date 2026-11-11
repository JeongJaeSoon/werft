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
  get(ownerId: string, sessionId: string): Promise<SessionShare | null>;
  /** Wakes the session's open streams so each re-checks what it may see. */
  set(input: SetSessionShareInput): Promise<SetSessionShareResult>;
  /** Newest first, whatever each session's share. */
  listForAdmin(ownerId: string, limit: number): Promise<AdminSessionRow[]>;
}
