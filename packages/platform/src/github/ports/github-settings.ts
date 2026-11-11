import type {
  ApiErrorCode,
  GitHubAppRole,
  GitHubCeiling,
  GitHubFeatures,
  ReceiptActor,
} from "@werft-ai/contracts";
import type { SecretAudit } from "../../ports/secret-store.ts";

/** What a GA-1 image answered for a release with GitHub settings. */
export const GITHUB_SETTINGS_UNSUPPORTED: {
  code: ApiErrorCode;
  message: string;
} = {
  code: "GITHUB_REFUSED",
  message:
    "The session's release has GitHub settings this server cannot apply yet",
};

export type GitHubWorkspaceSettings = {
  ceiling: GitHubCeiling;
  /** 0 when no row was ever written. */
  revision: number;
};

/** The author App's user authorization, as linking a person needs it. */
export type GitHubOAuthClient = {
  /** The connection the client is, bound into the link's state. */
  connectionId: string;
  clientId: string;
  clientSecret: string;
  /** Where GitHub shows the consent screen: the App page's origin. */
  webBase: string;
  apiBase: string;
};

export type PutGitHubOAuthSecretResult =
  | { outcome: "stored" }
  | {
      outcome:
        | "no_author_app"
        | "actor_inactive"
        | "outranked"
        | "workspace_not_found"
        /** The author App's client id is not the one the secret was for. */
        | "client_changed";
    };

/**
 * The OAuth client secret is sealed under the author App's row, so it goes
 * with that App; `oauth_client_secret_set` says whether it is there.
 */
export interface GitHubOAuthStore {
  status(workspaceId: string): Promise<{
    authorApp: boolean;
    /** The connection people link with, as the read rule picks it. */
    connectionId: string | null;
    clientId: string | null;
    clientSecretSet: boolean;
  }>;
  /** Null unless the author App, its client id and the secret are all there. */
  client(workspaceId: string): Promise<GitHubOAuthClient | null>;
  /**
   * Writes `set_github_app` (purpose `oauth_client_secret`) with it, under
   * the App lock and only while the author App's client id is `clientId`:
   * a secret is one App's, and a replacement may land while it is typed.
   */
  putClientSecret(
    workspaceId: string,
    clientSecret: string,
    audit: SecretAudit,
    clientId: string,
  ): Promise<PutGitHubOAuthSecretResult>;
}

export type PutGitHubCeilingResult =
  | { outcome: "stored"; settings: GitHubWorkspaceSettings }
  | { outcome: "revision_conflict" | "workspace_not_found" | "actor_inactive" };

/** The workspace GitHub settings row (`github_workspace_settings`). */
export interface GitHubSettingsStore {
  get(workspaceId: string): Promise<GitHubWorkspaceSettings>;
  /** Agents with GitHub on whose active release turns each feature on. */
  agentsUsing(
    workspaceId: string,
  ): Promise<Record<keyof GitHubFeatures, number>>;
  /** The permissions each App's row last read, or null when none is registered. */
  appPermissions(
    workspaceId: string,
  ): Promise<
    Record<
      GitHubAppRole,
      { permissions: Record<string, "read" | "write" | "admin"> | null } | null
    >
  >;
  /** CAS on `revision`; writes `set_github_ceiling` with it. */
  putCeiling(input: {
    workspaceId: string;
    ceiling: GitHubCeiling;
    revision: number;
    updatedBy: string;
    actor: ReceiptActor;
  }): Promise<PutGitHubCeilingResult>;
}
