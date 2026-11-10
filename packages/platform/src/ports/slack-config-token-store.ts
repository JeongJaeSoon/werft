import type {
  DeleteSecretResult,
  SecretAudit,
  SecretSummary,
} from "./secret-store.ts";

/** What Slack answers to `tooling.tokens.rotate`; stored encrypted, never shown. */
export type RotatedConfigToken = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  issuerUserId: string;
  issuerTeamId: string;
};

export type ConfigTokenState = "unset" | "active" | "needs_reentry";

export type ConfigTokenSummary = {
  state: ConfigTokenState;
  secret: SecretSummary | null;
  expiresAt: Date | null;
  issuer: { userId: string; teamId: string } | null;
};

/**
 * What a caller who wants an access token is told. `claimed`: it holds the
 * lease and must rotate `refreshToken`, then `complete`, `release` or
 * `invalidate`. `busy`: another process holds the lease until `until`.
 */
export type ConfigTokenClaim =
  | { outcome: "fresh"; accessToken: string; issuerUserId: string }
  | { outcome: "claimed"; leaseId: string; refreshToken: string }
  | { outcome: "busy"; until: Date }
  | { outcome: "not_set" | "needs_reentry" };

export type ReplaceClaim =
  | { outcome: "claimed"; leaseId: string }
  | { outcome: "busy"; until: Date }
  | { outcome: "actor_inactive" | "outranked" | "workspace_not_found" };

export type CompleteResult =
  | {
      outcome: "stored";
      summary: ConfigTokenSummary;
      /** The issuer before this rotation, when it was someone else. */
      previousIssuerUserId: string | null;
    }
  | { outcome: "lease_lost" };

/**
 * A workspace's App Configuration Token: the access and refresh tokens
 * sealed as one secret, with the expiry, issuer and rotation lease in plain
 * columns. Every method runs its own short transaction; none is open while
 * Slack is asked, and the lease, not a held lock, keeps a second process
 * from spending the single-use refresh token.
 */
export interface SlackConfigTokenStore {
  /**
   * The access token while it is valid past `freshUntil`; otherwise the
   * lease. A lease found expired means a rotation's answer may be lost with
   * the refresh token in it, so the slot turns `needs_reentry`.
   */
  claim(
    workspaceId: string,
    clock: { now: Date; freshUntil: Date; leaseUntil: Date },
  ): Promise<ConfigTokenClaim>;
  /** The lease for storing a pasted token, whatever state the slot is in. */
  claimForReplace(
    workspaceId: string,
    clock: { now: Date; leaseUntil: Date },
    audit: SecretAudit,
  ): Promise<ReplaceClaim>;
  /**
   * Stores what Slack answered and frees the lease, when the lease is still
   * this caller's. With `audit`, also the receipt and who set it.
   */
  complete(
    workspaceId: string,
    leaseId: string,
    rotated: RotatedConfigToken,
    audit?: SecretAudit,
  ): Promise<CompleteResult>;
  /** Frees the lease and leaves the token as it was. */
  release(workspaceId: string, leaseId: string): Promise<void>;
  /**
   * Drops the stored pair and marks the slot `needs_reentry`. With a
   * `leaseId`, only while that lease is still the current one.
   */
  invalidate(workspaceId: string, leaseId: string | null): Promise<void>;
  /** Makes the next caller rotate: Slack said the access token expired. */
  expireAccess(workspaceId: string, now: Date): Promise<void>;
  describe(workspaceId: string): Promise<ConfigTokenSummary>;
  delete(workspaceId: string, audit: SecretAudit): Promise<DeleteSecretResult>;
}
