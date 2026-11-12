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
