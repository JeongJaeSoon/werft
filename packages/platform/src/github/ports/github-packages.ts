import type {
  GitHubPackagesAllowEntry,
  GitHubPackagesRefusal,
  GitHubPackagesRegistry,
  ReceiptActor,
} from "@werft-ai/contracts";
import type { SecretAudit, SecretSummary } from "../../ports/secret-store.ts";

/** The workspace's GitHub Packages settings as the console reads them. */
export type GitHubPackagesSettings = {
  token:
    | (SecretSummary & { login: string | null; expiresAt: Date | null })
    | null;
  allowlist: GitHubPackagesAllowEntry[];
  /** 0 until the allowlist is first saved. */
  revision: number;
};

export type GitHubPackagesWriteRefusal =
  | "actor_inactive"
  | "outranked"
  | "workspace_not_found";

/** What GitHub said of a token when it was registered. */
export type GitHubPackagesTokenFacts = {
  login: string;
  expiresAt: Date | null;
};

/** What a GitHub Packages request is judged on, read fresh for each one. */
export type GitHubPackagesSessionState = {
  /** The session's owner, which its receipts are listed under. */
  ownerId: string;
  workspaceId: string;
  /** Null for a session that pins no agent release. */
  agentId: string | null;
  releaseId: string | null;
  /** Who started the session, as its receipts name them. */
  actor: ReceiptActor | null;
  token: { value: string; expiresAt: Date | null } | null;
  allowlist: GitHubPackagesAllowEntry[];
};

export type GitHubPackageFetchRecord = {
  id: string;
  ownerId: string;
  sessionId: string;
  status: "succeeded" | "failed";
  actor: ReceiptActor | null;
  result: {
    attempt_id: string;
    agent_id: string | null;
    release_id: string | null;
    repository_id: string | null;
    registry: GitHubPackagesRegistry;
    owner: string | null;
    package: string | null;
    version: string | null;
    reason_code: GitHubPackagesRefusal | null;
  };
};

/**
 * The bot token sits in `secret_values` under the workspace; its login,
 * expiry and the allowlist in `github_packages_settings`. Every write
 * re-reads the caller's role under lock and writes its receipt in the same
 * transaction.
 */
export interface GitHubPackagesStore {
  get(workspaceId: string): Promise<GitHubPackagesSettings>;
  putToken(input: {
    workspaceId: string;
    token: string;
    facts: GitHubPackagesTokenFacts;
    audit: SecretAudit;
  }): Promise<{ outcome: "stored" } | { outcome: GitHubPackagesWriteRefusal }>;
  deleteToken(input: {
    workspaceId: string;
    audit: SecretAudit;
  }): Promise<
    | { outcome: "deleted" | "not_found" }
    | { outcome: GitHubPackagesWriteRefusal }
  >;
  /** CAS on `revision`. */
  putAllowlist(input: {
    workspaceId: string;
    allowlist: GitHubPackagesAllowEntry[];
    revision: number;
    audit: SecretAudit;
  }): Promise<
    | { outcome: "stored" }
    | { outcome: GitHubPackagesWriteRefusal | "revision_conflict" }
  >;
  /** The allowlist alone, for a claim; empty when the workspace has none. */
  allowlist(workspaceId: string): Promise<GitHubPackagesAllowEntry[]>;
  /** Null when the session is gone. */
  sessionState(sessionId: string): Promise<GitHubPackagesSessionState | null>;
  /**
   * In its own transaction, after the decision: a receipt that cannot be
   * written must not turn an allowed fetch into an outage, so a failure is
   * the caller's to log.
   */
  recordFetch(record: GitHubPackageFetchRecord): Promise<void>;
}

/** Reads what GitHub says of a token; the console's check before storing it. */
export interface GitHubPackagesTokenVerifier {
  verify(
    token: string,
  ): Promise<
    | { outcome: "ok"; facts: GitHubPackagesTokenFacts }
    | { outcome: "rejected"; reason: "invalid" | "scopes"; scopes: string[] }
    | { outcome: "unavailable" }
  >;
}
