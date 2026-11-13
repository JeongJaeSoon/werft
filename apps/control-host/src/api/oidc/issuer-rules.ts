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

/**
 * Why these rules for who may come in cannot be saved for this provider;
 * null when they can. Anyone can make a Google account and Google always
 * says whether the address is verified, so there the address must be
 * verified, and nobody joins by themselves without a domain list.
 */
export function policyProblem(
  issuer: string,
  policy: {
    allowedDomains: readonly string[];
    jitRole: "member" | null;
    requireVerifiedEmail: boolean;
  },
): "verified_email_required" | "jit_requires_domains" | null {
  if (issuer !== GOOGLE_ISSUER) return null;
  if (!policy.requireVerifiedEmail) return "verified_email_required";
  return policy.jitRole !== null && policy.allowedDomains.length === 0
    ? "jit_requires_domains"
    : null;
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
