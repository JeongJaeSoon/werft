// The places where one provider differs from the specification. A provider
// is otherwise a row of settings, not code.

export const GOOGLE_ISSUER = "https://accounts.google.com";

/** Every spelling of the issuer the provider may put in an id_token's `iss`. */
export function tokenIssuers(issuer: string): string[] {
  // Google names its issuer with or without the scheme.
  return issuer === GOOGLE_ISSUER
    ? [GOOGLE_ISSUER, "accounts.google.com"]
    : [issuer];
}

/** Extra authorization request parameters this provider understands. */
export function authorizationParams(
  issuer: string,
  allowedDomains: readonly string[],
): Record<string, string> {
  // Lets Google preselect the account; the domain is still enforced on the
  // id_token, never trusted from here.
  const [only] = allowedDomains;
  return issuer === GOOGLE_ISSUER && allowedDomains.length === 1 && only
    ? { hd: only }
    : {};
}
