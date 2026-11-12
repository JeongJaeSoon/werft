/**
 * An OIDC provider people sign in with: one row of settings for the whole
 * installation, one per issuer.
 */
export type LoginProvider = {
  /** Part of the redirect URI registered at the provider. */
  id: string;
  displayName: string;
  issuer: string;
  // What discovery named when it was last checked. A sign-in uses these and
  // never reads discovery itself.
  authorizationEndpoint: string;
  tokenEndpoint: string;
  jwksUri: string;
  userinfoEndpoint: string | null;
  signingAlgs: ("RS256" | "ES256")[];
  issParameterRequired: boolean;
  /** Null until the redirect URI is registered at the provider. */
  clientId: string | null;
  tokenAuthMethod: "client_secret_basic" | "client_secret_post";
  /** Lower-cased; empty restricts nothing. */
  allowedDomains: string[];
  jitRole: "member" | null;
  requireVerifiedEmail: boolean;
  enabled: boolean;
  /** Goes up with every connection or policy change. */
  configRevision: number;
};

/** A stored client secret, never its value. */
export type LoginProviderSecretSummary = {
  last4: string;
  secretVersion: number;
  updatedAt: Date;
};

/** A provider as its owner sees it: the settings and where they stand. */
export type LoginProviderRecord = LoginProvider & {
  pkceAdvertised: boolean;
  discoveryCheckedAt: Date;
  /** The `configRevision` a test sign-in last passed with. */
  testedConfigRevision: number | null;
  testedAt: Date | null;
  /** Goes up with every change; a change names the one it was read at. */
  revision: number;
  createdAt: Date;
  updatedAt: Date;
  clientSecret: LoginProviderSecretSummary | null;
  /** A replacement waiting for a test sign-in; only while the provider is on. */
  pendingClientSecret: LoginProviderSecretSummary | null;
};

/** What discovery named; what a provider row pins. */
export type LoginProviderEndpoints = Pick<
  LoginProvider,
  | "issuer"
  | "authorizationEndpoint"
  | "tokenEndpoint"
  | "jwksUri"
  | "userinfoEndpoint"
  | "signingAlgs"
  | "issParameterRequired"
> & {
  pkceAdvertised: boolean;
  /** Never empty; the first is the default. */
  tokenAuthMethods: LoginProvider["tokenAuthMethod"][];
};

/** The owner making a change, and the receipt it leaves. */
export type LoginProviderAudit = {
  userId: string;
  workspaceId: string;
  receiptId: string;
};

export type LoginProviderChanges = Partial<
  Pick<
    LoginProvider,
    | "displayName"
    | "clientId"
    | "tokenAuthMethod"
    | "allowedDomains"
    | "jitRole"
    | "requireVerifiedEmail"
  >
>;

/** Which stored secret a test sign-in runs with. */
export type LoginProviderSecretSlot = "current" | "next";

/**
 * The owner's changes to the providers. Every write is one transaction
 * with its receipt; a secret's value goes in and never comes out of here
 * except to the server's own test sign-in.
 */
export interface LoginProviderAdminStore {
  list(): Promise<LoginProviderRecord[]>;
  /** Made off, with what discovery named. */
  create(input: {
    id: string;
    displayName: string;
    endpoints: LoginProviderEndpoints;
    audit: LoginProviderAudit;
  }): Promise<
    | { outcome: "created"; provider: LoginProviderRecord }
    | { outcome: "issuer_taken" }
  >;
  /**
   * `locked`: the provider is on and the change names its client id or
   * client authentication. `stale`: it changed since `ifMatch` was read.
   */
  update(input: {
    id: string;
    ifMatch: number;
    changes: LoginProviderChanges;
    audit: LoginProviderAudit;
  }): Promise<
    | { outcome: "updated"; provider: LoginProviderRecord }
    | { outcome: "not_found" | "locked" }
    | { outcome: "stale"; revision: number }
  >;
  /** Replaces the pinned endpoints; only while the provider is off. */
  refreshDiscovery(input: {
    id: string;
    endpoints: LoginProviderEndpoints;
    audit: LoginProviderAudit;
  }): Promise<
    | { outcome: "updated"; provider: LoginProviderRecord }
    | { outcome: "not_found" | "locked" | "issuer_changed" }
  >;
  /**
   * Off: the value becomes the provider's secret. On: it waits as the
   * replacement and sign-ins keep the one they have.
   */
  setClientSecret(input: {
    id: string;
    value: string;
    audit: LoginProviderAudit;
  }): Promise<
    | { outcome: "stored"; provider: LoginProviderRecord }
    | { outcome: "not_found" | "no_workspace" }
  >;
  /** The provider with the secret a test sign-in runs with now. */
  findForTest(id: string): Promise<{
    provider: LoginProvider;
    slot: LoginProviderSecretSlot;
    clientSecret: string | null;
    secretVersion: number | null;
  } | null>;
  /**
   * Writes down that a test sign-in passed, only if the settings and the
   * secret it ran with are still the ones stored: `stale` otherwise, and
   * nothing is written. A replacement secret that passed becomes the
   * provider's secret here.
   */
  recordTest(input: {
    id: string;
    configRevision: number;
    slot: LoginProviderSecretSlot;
    /** The value the provider just accepted. */
    clientSecret: string;
    audit: LoginProviderAudit;
  }): Promise<{ outcome: "recorded" | "stale" | "not_found" }>;
  /** `not_ready`: the settings as they are have not passed a test sign-in. */
  enable(input: {
    id: string;
    audit: LoginProviderAudit;
  }): Promise<
    | { outcome: "enabled"; provider: LoginProviderRecord }
    | { outcome: "not_found" | "not_ready" }
  >;
  /** Turns it off and ends the sessions made through it. */
  disable(input: { id: string; audit: LoginProviderAudit }): Promise<
    | {
        outcome: "disabled";
        provider: LoginProviderRecord;
        sessionsRevoked: number;
      }
    | { outcome: "not_found" }
  >;
  /** Only a provider that is off; its secrets go with it. */
  delete(input: {
    id: string;
    audit: LoginProviderAudit;
  }): Promise<{ outcome: "deleted" | "not_found" | "enabled" }>;
  /**
   * What a sign-in by this external account would meet, without making
   * anything: it is connected to a user, or its address has an account, or
   * neither.
   */
  previewEntry(input: {
    issuer: string;
    subject: string;
    email: string | null;
  }): Promise<"linked" | "account_exists" | "none">;
}

export interface LoginProviderStore {
  /** The providers that are turned on, oldest first. */
  listEnabled(): Promise<{ id: string; displayName: string }[]>;
  /**
   * The provider with its client secret, for the server's own calls to it.
   * The secret is null when none is stored or the stored one does not open.
   */
  findForSignIn(
    id: string,
  ): Promise<{ provider: LoginProvider; clientSecret: string | null } | null>;
}
