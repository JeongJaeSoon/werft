import type {
  GitHubAppCheckFailure,
  GitHubAppConflict,
  GitHubAppPermissions,
  GitHubAppRole,
  GitHubAppUsage,
  GitHubUnavailable,
  ReceiptActor,
} from "@werft-ai/contracts";
import type { RepoRef } from "../../action/ports/forge.ts";
import type { SecretAudit } from "../../ports/secret-store.ts";

/** What GitHub says the App is, read with the App's own JWT. */
export type GitHubAppProfile = {
  appId: number;
  slug: string;
  name: string;
  htmlUrl: string;
  /** What the App asks for (`GET /app`'s `permissions`). */
  permissions: GitHubAppPermissions;
  /** The client for the App's user authorization; null when GitHub sent none. */
  clientId: string | null;
};

export type GitHubAppOwner = {
  login: string;
  type: "organization" | "user";
};

/** The workspace's GitHub App as stored, without its private key. */
export type GitHubAppRecord = Omit<GitHubAppProfile, "permissions"> & {
  /** Null on a row an earlier image wrote, until the next read. */
  permissions: GitHubAppPermissions | null;
  permissionsCheckedAt: Date | null;
  /** The row's own id; the private key is sealed under it. */
  id: string;
  workspaceId: string;
  apiBase: string;
  createdAt: Date;
  updatedAt: Date;
  privateKey: {
    updatedAt: Date;
    updatedBy: { userId: string; displayName: string } | null;
  };
};

/** What the server signs with: for its own GitHub calls only. */
export type GitHubAppCredential = {
  id: string;
  workspaceId: string;
  appId: number;
  apiBase: string;
  privateKey: string;
  /** Changes whenever the App or its key is replaced. */
  updatedAt: Date;
};

export type PutGitHubAppResult =
  | {
      outcome: "stored";
      app: GitHubAppRecord & { role: GitHubAppRole };
      /** Pins of the connection a replacement by another App dropped. */
      pinsCleared: number;
      /** Emptied pins of this App filled again with this connection. */
      pinsRestored: number;
    }
  | {
      outcome:
        | "actor_inactive"
        | "outranked"
        | "workspace_not_found"
        | "not_found"
        | "app_id_mismatch";
    }
  /** Decided under the workspace's lock, so two writes cannot both pass. */
  | { outcome: GitHubAppConflict };

export type DeleteGitHubAppResult =
  | { outcome: "deleted"; appId: number; usage: GitHubAppUsage }
  | {
      outcome:
        | "not_found"
        | "actor_inactive"
        | "outranked"
        | "ambiguous_role"
        | "in_use_for_user_link";
    };

/**
 * Which connection a write is for. A role address serves a role with at most
 * one connection, as before several Apps a role (decision github-agent.md
 * 11.1); a connection id takes only a new key for the same App.
 */
export type GitHubAppTarget =
  | { kind: "role"; role: GitHubAppRole }
  | { kind: "add"; role: GitHubAppRole }
  | { kind: "connection"; id: string };

export type SetUserLinkResult =
  | { outcome: "stored"; before: string | null; changed: boolean }
  | {
      outcome:
        | "not_found"
        | "role_mismatch"
        | "actor_inactive"
        | "outranked"
        | "workspace_not_found";
    };

/** A catalog repository's pinned connection for one role. */
export type GitHubRepositoryPin = {
  repositoryId: string;
  role: GitHubAppRole;
  /** Null: the pinned connection was removed. */
  connectionId: string | null;
  appId: number;
  pinnedBy: "selection" | "first_mint" | "admin" | "claim";
};

type PinFirstTarget = {
  repositoryId: string;
  role: GitHubAppRole;
  connectionId: string;
  appId: number;
};

/** A claim's pin: for its commit author, so audited with the session. */
export type ClaimPinAudit = { sessionId: string; receiptId: string };

export type SetGitHubPinResult =
  | { outcome: "stored"; before: string | null; changed: boolean }
  | { outcome: "not_found" | "role_mismatch" };

/**
 * The connection each catalog repository's work uses (decision
 * github-agent.md 11, "저장소에 고정된 연결").
 */
export interface GitHubPinStore {
  get(
    repositoryId: string,
    role: GitHubAppRole,
  ): Promise<GitHubRepositoryPin | null>;
  list(): Promise<GitHubRepositoryPin[]>;
  /**
   * Pins `connectionId` unless the repository already has a pin for the
   * role, and answers the pin that holds. A `selection` or `claim` pin
   * writes its `set_repository_github_app` receipt in the same transaction,
   * so no pin stands unaudited. `pin` is null when nothing holds and the
   * connection is no longer `appId` of `role`: nothing is written.
   */
  pinFirst(
    input: PinFirstTarget &
      (
        | {
            pinnedBy: "selection" | "first_mint";
            /** A selection's actor and receipt; absent for a first mint. */
            audit?: { ownerId: string; actor: ReceiptActor; receiptId: string };
          }
        | { pinnedBy: "claim"; audit: ClaimPinAudit }
      ),
  ): Promise<{ pin: GitHubRepositoryPin | null; created: boolean }>;
  /** An admin's change; the connection must be of the workspace and role. */
  set(input: {
    workspaceId: string;
    repositoryId: string;
    role: GitHubAppRole;
    connectionId: string;
    actor: ReceiptActor;
    receiptId: string;
  }): Promise<SetGitHubPinResult>;
}

/** What a manifest's code turned into on GitHub, secrets included. */
export type GitHubAppManifestConversion = GitHubAppProfile & {
  privateKey: string;
  clientSecret: string;
  /** The login that owns the App. */
  owner: string;
};

/** A manifest made in the console, stored with what its state is bound to. */
export type GitHubAppManifestState = {
  workspaceId: string;
  actorUserId: string;
  role: GitHubAppRole;
  /** Null: the actor's own account. */
  ownerLogin: string | null;
  public: boolean;
  /** The author App registered at the start; null when there was none. */
  replacesAppId: number | null;
  expiresAt: Date;
};

export interface GitHubAppManifestStore {
  /** Stores a new state and drops states that expired before `now`. */
  issueState(
    stateHash: Uint8Array,
    state: GitHubAppManifestState,
    now: Date,
  ): Promise<void>;
  /** Removes the state and returns it, so it is spent whatever comes next. */
  consumeState(stateHash: Uint8Array): Promise<GitHubAppManifestState | null>;
}

/** What `put` also stores when the App came from a manifest. */
export type GitHubAppManifestPut = {
  /** Kept only when the new connection is the one people link with. */
  clientSecret: string;
  owner: string;
  public: boolean;
};

/**
 * The workspace's GitHub App connections, any number a role (decision
 * github-agent.md 11). A role address still names one connection while its
 * role has at most one, so a caller that only knows a role never reads,
 * replaces or deletes a connection it cannot tell apart.
 */
export interface GitHubAppStore {
  /** A role's connections, oldest first. */
  ofRole(
    workspaceId: string,
    role: GitHubAppRole,
  ): Promise<Array<GitHubAppRecord & { role: GitHubAppRole }>>;
  get(
    workspaceId: string,
    connectionId: string,
  ): Promise<(GitHubAppRecord & { role: GitHubAppRole }) | null>;
  /** Registers, adds or replaces a connection; the receipt is written with it. */
  put(
    workspaceId: string,
    target: GitHubAppTarget,
    app: GitHubAppProfile & { apiBase: string },
    privateKey: string,
    audit: SecretAudit,
    manifest?: GitHubAppManifestPut,
  ): Promise<PutGitHubAppResult>;
  /** Removes a connection with its key; its pins stay, emptied. */
  delete(
    workspaceId: string,
    target: Exclude<GitHubAppTarget, { kind: "add" }>,
    audit: SecretAudit,
  ): Promise<DeleteGitHubAppResult>;
  /** What removing the connection affects; null when it is not the workspace's. */
  usage(
    workspaceId: string,
    connectionId: string,
  ): Promise<GitHubAppUsage | null>;
  /**
   * The author connection people link their accounts with; its OAuth client
   * secret goes with the change.
   */
  setUserLink(
    workspaceId: string,
    connectionId: string,
    audit: SecretAudit,
  ): Promise<SetUserLinkResult>;
  /**
   * Keeps a later read of the App's permissions on the row `id` names, while
   * that row still holds App `appId`: a replacement keeps the row's id, and a
   * read of the App it replaced must not land on the new one.
   */
  recordPermissions(
    id: string,
    appId: number,
    permissions: GitHubAppPermissions,
    /** Left out: the row keeps the client id it has. */
    clientId?: string | null,
  ): Promise<void>;
  list(
    workspaceId: string,
  ): Promise<Array<GitHubAppRecord & { role: GitHubAppRole }>>;
  /** Every registered App of `role` with its key, or one workspace's. */
  credentials(
    role: GitHubAppRole,
    workspaceId?: string,
  ): Promise<GitHubAppCredential[]>;
}

export type GitHubAppInstallationView = {
  id: number;
  account: string;
  accountType: "organization" | "user";
  accountId: number | null;
  repositorySelection: "all" | "selected";
  htmlUrl: string | null;
  /** What the account approved for this installation. */
  permissions: GitHubAppPermissions;
  createdAt: Date | null;
  suspendedAt: Date | null;
};

/** GitHub's side of a registered App, asked with the App's JWT. */
export interface GitHubAppDirectory {
  /** `owner` is null when GitHub named none. */
  describe(
    app: Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">,
  ): Promise<GitHubAppProfile & { owner?: GitHubAppOwner | null }>;
  installations(
    app: Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">,
  ): Promise<GitHubAppInstallationView[]>;
  /** One installation of this App (`GET /app/installations/{id}`); null when it is not one. */
  installation(
    app: Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">,
    installationId: number,
  ): Promise<GitHubAppInstallationView | null>;
  /**
   * The installation that covers `repo` and what it grants, or null when
   * there is none.
   */
  installationFor(
    app: Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">,
    repo: RepoRef,
  ): Promise<{ id: number; permissions: GitHubAppPermissions } | null>;
  /** One page of the repositories an installation can reach, as GitHub pages them. */
  installationRepositoriesPage(
    app: Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">,
    installationId: number,
    page: { page: number; perPage: number },
  ): Promise<{
    repositories: GitHubInstallationRepository[];
    totalCount: number;
  }>;
  /**
   * The repository with that GitHub id as the installation's token reads it,
   * or null when it cannot. A public repository reads whether or not the
   * installation covers it: check that with `installationFor`.
   */
  repositoryById(
    app: Pick<GitHubAppCredential, "appId" | "apiBase" | "privateKey">,
    installationId: number,
    repositoryId: number,
  ): Promise<GitHubInstallationRepository | null>;
}

export type GitHubInstallationSnapshot = {
  installations: GitHubAppInstallationView[];
  readAt: Date;
};

export type GitHubInstallationState = {
  workspaceId: string;
  connectionId: string;
  appId: number;
  actorUserId: string;
  createdAt: Date;
  expiresAt: Date;
};

export type GitHubInstallationLink = {
  connectionId: string;
  installationId: number;
  connectedBy: { userId: string; displayName: string } | null;
  connectedAt: Date;
};

/**
 * What the platform keeps of a connection's installations (design GHUI-v3
 * §8): the last list GitHub gave, and who connected an installation from the
 * console. Neither decides access.
 */
export interface GitHubInstallationStore {
  /** Kept while the row `connectionId` names still holds App `appId`. */
  recordSnapshot(
    connectionId: string,
    appId: number,
    snapshot: GitHubInstallationSnapshot,
  ): Promise<void>;
  /** Null when none was kept for App `appId` on that row. */
  snapshot(
    connectionId: string,
    appId: number,
  ): Promise<GitHubInstallationSnapshot | null>;
  /** Stores a new state and drops states that expired before `now`. */
  issueState(
    stateHash: Uint8Array,
    state: GitHubInstallationState,
    now: Date,
  ): Promise<void>;
  /** Removes the state and returns it, so it is spent whatever comes next. */
  consumeState(stateHash: Uint8Array): Promise<GitHubInstallationState | null>;
  /**
   * Writes the link while the connection still holds `appId` and no link
   * exists for that installation; true when this call wrote it.
   */
  recordLink(input: {
    workspaceId: string;
    connectionId: string;
    appId: number;
    installationId: number;
    connectedBy: string;
  }): Promise<boolean>;
  /** The workspace's links, for connections that still hold the App linked. */
  links(workspaceId: string): Promise<GitHubInstallationLink[]>;
}

export type GitHubInstallationRepository = {
  id: number;
  owner: string;
  name: string;
  url: string;
  defaultBranch: string;
  private: boolean;
};

export const githubUnavailableOf = (error: unknown): GitHubUnavailable =>
  error instanceof GitHubAppCheckError && error.reason === "github_rejected"
    ? "github_app_auth_failed"
    : "github_unavailable";

/** A GitHub answer that says nothing about the request's own values. */
export class GitHubAppCheckError extends Error {
  override readonly name = "GitHubAppCheckError";
  constructor(
    readonly reason: GitHubAppCheckFailure,
    /** GitHub's HTTP status; absent when it did not answer. */
    readonly status?: number,
  ) {
    super(`GitHub App check failed: ${reason}`);
  }
}
