import type { MembershipRole } from "./identity-store.ts";

/** The provider a flow ran against, as the callback read it. */
type FlowProvider = { id: string; configRevision: number };

/** The external account a flow ended in. */
type ExternalAccount = {
  issuer: string;
  subject: string;
  /**
   * The address, only when the provider vouches the person owns it. Kept
   * on the link as a record; it decides nothing here.
   */
  vouchedEmail: string | null;
};

/** A sign-up by invite token through a provider (design 6.5). */
export type InviteSignUpInput = ExternalAccount & {
  provider: FlowProvider;
  /** The one invite the flow was started with. */
  inviteId: string;
  /** What the provider calls the person; null falls back to the invite's address. */
  name: string | null;
  newUserId: string;
  newLoginMethodId: string;
  receiptId: string;
  session: {
    id: string;
    tokenHash: Uint8Array;
    ttlMs: number;
    userAgent: string | null;
    maxLive: number;
  };
};

export type InviteSignUpResult =
  | {
      outcome: "signed_in";
      userId: string;
      workspaceId: string;
      role: MembershipRole;
      expiresAt: Date;
    }
  /** Expired, used or revoked, whoever the external account is. */
  | { outcome: "invite_gone" }
  /** The external account is somebody's already. */
  | { outcome: "already_linked" }
  /** The invite's address has an account; nothing is joined to it. */
  | { outcome: "link_required" }
  | { outcome: "provider_off" };

/** Linking an external account to the user of a live session (design 6.4). */
export type LinkLoginMethodInput = ExternalAccount & {
  provider: FlowProvider;
  userId: string;
  /** The session the link was started from; it must still be live. */
  sessionId: string;
  workspaceId: string;
  newLoginMethodId: string;
  receiptId: string;
};

export type LinkLoginMethodResult =
  | { outcome: "linked"; loginMethodId: string }
  | { outcome: "provider_off" }
  | { outcome: "session_gone" }
  /** The external account is linked already, to this user or another. */
  | { outcome: "already_linked" }
  /** The user has another account of this issuer linked. */
  | { outcome: "issuer_linked" };

export type LoginMethodRecord = {
  id: string;
  kind: "password" | "oidc";
  /** The provider of an external method, when one with its issuer exists. */
  provider: { id: string; displayName: string; enabled: boolean } | null;
  issuer: string | null;
  emailAtLink: string | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  /** Whether the user can sign in with it now. */
  usable: boolean;
};

export type LoginMethodsRecord = {
  methods: LoginMethodRecord[];
  /** Providers that are on and that the user has no account of. */
  linkable: { id: string; displayName: string }[];
};

export type UnlinkLoginMethodInput = {
  userId: string;
  loginMethodId: string;
  workspaceId: string;
  receiptId: string;
};

export type UnlinkLoginMethodResult =
  | { outcome: "unlinked"; sessionsRevoked: number }
  | { outcome: "not_found" }
  /** Nothing the user could sign in with would be left. */
  | { outcome: "last_method" };

/** How people come to have, and stop having, ways to sign in. */
export interface LoginMethodStore {
  /**
   * The invite a token names, when it can still be redeemed. Says what a
   * password accept says of the same token; the sign-up reads it again.
   */
  inviteForSignUp(
    tokenHash: Uint8Array,
  ): Promise<
    | { outcome: "pending"; inviteId: string }
    | { outcome: "expired" | "used" | "unknown" }
  >;
  signUpWithInvite(input: InviteSignUpInput): Promise<InviteSignUpResult>;
  /**
   * Whether this live session of this user was made no longer ago than
   * `maxAgeMs`, on the database clock. A link may start only from one.
   */
  sessionIsFresh(input: {
    sessionId: string;
    userId: string;
    maxAgeMs: number;
  }): Promise<boolean>;
  link(input: LinkLoginMethodInput): Promise<LinkLoginMethodResult>;
  list(userId: string): Promise<LoginMethodsRecord>;
  unlink(input: UnlinkLoginMethodInput): Promise<UnlinkLoginMethodResult>;
}
