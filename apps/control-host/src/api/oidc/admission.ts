import type { OidcIdentity } from "./flow.ts";
import { GOOGLE_ISSUER } from "./issuer-rules.ts";

/** The provider settings that decide who may come in and how. */
export type AdmissionPolicy = {
  issuer: string;
  /** Lower-cased; empty restricts nothing. */
  allowedDomains: readonly string[];
  jitRole: "member" | null;
};

export type Admission = {
  /**
   * The provider vouches the person owns the address today. Only then may
   * the address find an invite, join by itself, or be told an account
   * already has it.
   */
  ownsEmail: boolean;
  /** The role the address may join with on its own; null when it may not. */
  jitRole: "member" | null;
};

type Vouched = Pick<OidcIdentity, "email" | "emailVerified" | "claims">;

const domainOf = (email: string | null) =>
  email === null ? null : email.slice(email.lastIndexOf("@") + 1);

/** The address is on the Google account's own Workspace domain (`hd`). */
function onHostedDomain(identity: Vouched): boolean {
  const hostedDomain =
    typeof identity.claims.hd === "string"
      ? identity.claims.hd.toLowerCase()
      : null;
  return hostedDomain !== null && hostedDomain === domainOf(identity.email);
}

/**
 * Whether the provider vouches the person owns the address today.
 *
 * Signing in proves (issuer, subject). Owning the `email` claim is a
 * separate thing the provider has to say: `email_verified` for most, and
 * for Google also that the address is on gmail.com or on the account's own
 * Workspace domain (`hd`), since any other address was verified once at
 * sign-up and may since belong to someone else.
 */
export function ownsAddress(issuer: string, identity: Vouched): boolean {
  const verified = identity.email !== null && identity.emailVerified === true;
  return (
    verified &&
    (issuer !== GOOGLE_ISSUER ||
      onHostedDomain(identity) ||
      domainOf(identity.email) === "gmail.com")
  );
}

/** Null when a domain restriction keeps the person out. */
export function admit(
  policy: AdmissionPolicy,
  identity: Vouched,
): Admission | null {
  const domain = domainOf(identity.email);
  const google = policy.issuer === GOOGLE_ISSUER;
  const hosted = onHostedDomain(identity);
  const ownsEmail = ownsAddress(policy.issuer, identity);

  if (policy.allowedDomains.length === 0) {
    // Google lets anyone make an account, so with no domain list nobody
    // joins by themselves.
    return { ownsEmail, jitRole: google || !ownsEmail ? null : policy.jitRole };
  }
  // A Google account is inside by its Workspace domain, never by a
  // consumer address.
  const inside =
    ownsEmail &&
    domain !== null &&
    (!google || hosted) &&
    policy.allowedDomains.includes(domain);
  return inside ? { ownsEmail, jitRole: policy.jitRole } : null;
}
