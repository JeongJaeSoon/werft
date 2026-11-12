/**
 * The provider could not be reached, answered 5xx, or its name resolved to
 * an address the network policy refuses. Nothing about who is signing in was
 * decided; the caller may retry or an operator has to look.
 */
export class OidcUnavailableError extends Error {
  readonly kind: "unreachable" | "answered" | "address_not_allowed";

  constructor(kind: OidcUnavailableError["kind"], message: string) {
    super(message);
    this.name = "OidcUnavailableError";
    this.kind = kind;
  }
}

export type OidcRejection =
  | "response_issuer_mismatch"
  | "code_refused"
  | "no_id_token"
  | "malformed_token"
  | "alg_not_allowed"
  | "no_matching_key"
  | "bad_signature"
  | "issuer_mismatch"
  | "audience_mismatch"
  | "authorized_party_mismatch"
  | "expired"
  | "issued_at_invalid"
  | "not_yet_valid"
  | "nonce_mismatch"
  | "subject_invalid"
  | "userinfo_refused"
  | "userinfo_subject_mismatch"
  | "email_unverified";

/**
 * The flow or the provider's answer does not prove who is signing in. The
 * reason is for the server log; a response never tells them apart.
 */
export class OidcRejectedError extends Error {
  readonly reason: OidcRejection;

  constructor(reason: OidcRejection, message: string) {
    super(message);
    this.name = "OidcRejectedError";
    this.reason = reason;
  }
}

export type DiscoveryProblem =
  | "issuer_mismatch"
  | "invalid_document"
  | "insecure_endpoint"
  | "unsupported_flow"
  | "unsupported_algorithm"
  | "unsupported_client_auth"
  | "pkce_s256_unsupported";

/** The discovery document answered, and this client cannot work with it. */
export class OidcDiscoveryError extends Error {
  readonly problem: DiscoveryProblem;

  constructor(problem: DiscoveryProblem, message: string) {
    super(message);
    this.name = "OidcDiscoveryError";
    this.problem = problem;
  }
}
