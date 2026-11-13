// What counts as Keycloak refusing a wrong PKCE verifier at its token
// endpoint. A 400 alone proves nothing: a spent or expired code, a redirect
// URI that does not match and a failed client authentication are refused
// too. Only Keycloak's own PKCE refusal counts, and no token in the body.
// The description is the text of the Keycloak the overlay pins
// (infra/compose.keycloak.yml); a new image that words it differently fails
// here and is then read by a person.
const TOKENS = ["id_token", "access_token", "refresh_token"];

/** `line` names the error, its description and any tokens, never their values. */
export function pkceVerdict(status, text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return {
      refused: false,
      line: `${status} (the body is not a JSON object)`,
    };
  }
  const tokens = TOKENS.filter((name) => name in body);
  return {
    refused:
      status === 400 &&
      body.error === "invalid_grant" &&
      body.error_description === "PKCE verification failed: Code mismatch" &&
      tokens.length === 0,
    line: `${status} ${body.error} | ${body.error_description} | tokens: ${tokens.join(",") || "none"}`,
  };
}
